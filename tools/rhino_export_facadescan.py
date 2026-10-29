# -*- coding: utf-8 -*-
"""Export the open Rhino 7/8 document as a FacadeScan GLB + JSON package.

Run from Rhino's _RunPythonScript command. Then select the three generated
files ending in .glb, _manifest.json, and _audit.json in the FacadeScan UI.
"""
from __future__ import print_function

import json
import math
import os
import re
import struct
import System
import Rhino
import scriptcontext as sc
from System.Windows.Forms import DialogResult, FolderBrowserDialog


DIRECTIONS = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")
CATEGORIES = {
    "WALL": "WALL",
    "OPAQUE WALL": "WALL",
    "GLAZING": "WINDOW",
    "GLASS": "WINDOW",
    "WINDOW": "WINDOW",
    "SHADING_H": "SHADING_H",
    "HORIZONTAL SHADING": "SHADING_H",
    "OVERHANG": "SHADING_H",
    "SHADING_V": "SHADING_V",
    "VERTICAL SHADING": "SHADING_V",
    "FIN": "SHADING_V",
    "ROOF": "ROOF",
    "FLOOR": "FLOOR",
}
LEVEL_RE = re.compile(r"(?:^|_)L(\d+)(?:_|$)", re.IGNORECASE)
SEGMENT_RE = re.compile(r"(?:^|_)B(\d+)(?:_|$)", re.IGNORECASE)


def text(value):
    try:
        return unicode(value)
    except NameError:
        return str(value)


def json_text(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"))


def orientation_from_normal(normal):
    horizontal = math.hypot(normal[0], normal[1])
    if horizontal < 1e-8:
        return None, None
    azimuth = (math.degrees(math.atan2(normal[0], normal[1])) + 360.0) % 360.0
    sectors = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")
    return round(azimuth, 2), sectors[int((azimuth + 22.5) // 45.0) % 8]


def geometry_as_brep(geometry):
    if isinstance(geometry, Rhino.Geometry.Brep):
        return geometry
    if isinstance(geometry, Rhino.Geometry.Surface):
        return geometry.ToBrep()
    if isinstance(geometry, Rhino.Geometry.Extrusion):
        return geometry.ToBrep(True)
    return None


def mesh_geometry(geometry):
    if isinstance(geometry, Rhino.Geometry.Mesh):
        result = geometry.DuplicateMesh()
        result.Faces.ConvertQuadsToTriangles()
        return result if result.Vertices.Count and result.Faces.Count else None

    brep = geometry_as_brep(geometry)
    if brep is None:
        return None
    parts = Rhino.Geometry.Mesh.CreateFromBrep(brep, Rhino.Geometry.MeshingParameters.Default)
    if not parts:
        return None
    result = Rhino.Geometry.Mesh()
    for part in parts:
        result.Append(part)
    result.Faces.ConvertQuadsToTriangles()
    return result if result.Vertices.Count and result.Faces.Count else None


def exact_area(geometry, mesh, unit_scale):
    brep = geometry_as_brep(geometry)
    if brep is not None:
        props = Rhino.Geometry.AreaMassProperties.Compute(brep)
        if props is not None:
            return props.Area * unit_scale * unit_scale
    if isinstance(geometry, Rhino.Geometry.Mesh):
        props = Rhino.Geometry.AreaMassProperties.Compute(geometry)
        if props is not None:
            return props.Area * unit_scale * unit_scale
    props = Rhino.Geometry.AreaMassProperties.Compute(mesh)
    return props.Area * unit_scale * unit_scale if props is not None else None


def dominant_surface_normal(geometry, mesh):
    best_area = 0.0
    best_normal = None
    brep = geometry_as_brep(geometry)
    if brep is not None:
        for face in brep.Faces:
            props = Rhino.Geometry.AreaMassProperties.Compute(face)
            if props is None or props.Area <= best_area:
                continue
            u = (face.Domain(0).T0 + face.Domain(0).T1) / 2.0
            v = (face.Domain(1).T0 + face.Domain(1).T1) / 2.0
            normal = face.NormalAt(u, v)
            if face.OrientationIsReversed:
                normal.Reverse()
            if math.hypot(normal.X, normal.Y) > 0.5:
                best_area = props.Area
                best_normal = normal
    if best_normal is None:
        mesh.FaceNormals.ComputeFaceNormals()
        for index, face in enumerate(mesh.Faces):
            normal = mesh.FaceNormals[index]
            if math.hypot(normal.X, normal.Y) < 0.5:
                continue
            area = 0.0
            try:
                a = mesh.Vertices[face.A]
                b = mesh.Vertices[face.B]
                c = mesh.Vertices[face.C]
                area = Rhino.Geometry.Vector3d.CrossProduct(b - a, c - a).Length / 2.0
            except Exception:
                pass
            if area > best_area:
                best_area = area
                best_normal = Rhino.Geometry.Vector3d(normal)
    if best_normal is None:
        return None
    best_normal.Unitize()
    return (best_normal.X, best_normal.Y, best_normal.Z)


def layer_info(obj):
    layer = sc.doc.Layers[obj.Attributes.LayerIndex]
    layer_name = text(layer.FullPath)
    parts = layer_name.split("::")
    category = CATEGORIES.get(parts[0].strip().upper(), "REFERENCE")
    direction = None
    if len(parts) > 1:
        candidate = parts[-1].strip().upper()
        if candidate in DIRECTIONS:
            direction = candidate
    return layer_name, category, direction


def category_from_name(name):
    upper = name.upper()
    if "WINDOW" in upper or "GLAZ" in upper or "_WIN" in upper or "_GLASS" in upper:
        return "WINDOW"
    if "SHADING_H" in upper or "HORIZONTAL" in upper or "_OVERHANG" in upper:
        return "SHADING_H"
    if "SHADING_V" in upper or "VERTICAL" in upper or "_FIN" in upper:
        return "SHADING_V"
    if "WALL" in upper or "_OPAQUE" in upper:
        return "WALL"
    if "ROOF" in upper:
        return "ROOF"
    if "FLOOR" in upper or "SLAB" in upper:
        return "FLOOR"
    return "REFERENCE"


def aligned4(buffer):
    while len(buffer) % 4:
        buffer.append(0)


def add_binary_chunk(binary, data):
    aligned4(binary)
    offset = len(binary)
    binary.extend(data)
    return offset, len(data)


def make_gltf(exported):
    binary = bytearray()
    buffer_views = []
    accessors = []
    meshes = []
    nodes = []

    for item in exported:
        points = item["mesh"].Vertices
        positions = []
        for point in points:
            scale = item["unit_scale"]
            positions.extend((float(point.X) * scale, float(point.Z) * scale, -float(point.Y) * scale))
        indices = []
        for face in item["mesh"].Faces:
            indices.extend((face.A, face.B, face.C))
            if face.IsQuad:
                indices.extend((face.A, face.C, face.D))
        if not positions or not indices:
            continue

        position_bytes = struct.pack("<%sf" % len(positions), *positions)
        index_bytes = struct.pack("<%sI" % len(indices), *indices)
        position_offset, position_length = add_binary_chunk(binary, position_bytes)
        index_offset, index_length = add_binary_chunk(binary, index_bytes)

        position_view = len(buffer_views)
        buffer_views.append({"buffer": 0, "byteOffset": position_offset, "byteLength": position_length, "target": 34962})
        index_view = len(buffer_views)
        buffer_views.append({"buffer": 0, "byteOffset": index_offset, "byteLength": index_length, "target": 34963})

        xyz = list(zip(positions[0::3], positions[1::3], positions[2::3]))
        mins = [min(point[axis] for point in xyz) for axis in range(3)]
        maxs = [max(point[axis] for point in xyz) for axis in range(3)]
        position_accessor = len(accessors)
        accessors.append({
            "bufferView": position_view, "componentType": 5126, "count": len(points),
            "type": "VEC3", "min": mins, "max": maxs
        })
        index_accessor = len(accessors)
        accessors.append({"bufferView": index_view, "componentType": 5125, "count": len(indices), "type": "SCALAR"})
        mesh_index = len(meshes)
        meshes.append({"name": item["name"], "primitives": [{"attributes": {"POSITION": position_accessor}, "indices": index_accessor, "mode": 4}]})
        nodes.append({"name": item["name"], "mesh": mesh_index})

    document = {
        "asset": {"version": "2.0", "generator": "FacadeScan Rhino 8 exporter"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": meshes,
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": buffer_views,
        "accessors": accessors,
    }
    json_bytes = bytearray(json_text(document).encode("utf-8"))
    while len(json_bytes) % 4:
        json_bytes.append(0x20)
    aligned4(binary)
    total_length = 12 + 8 + len(json_bytes) + 8 + len(binary)
    header = struct.pack("<4sII", b"glTF", 2, total_length)
    json_header = struct.pack("<I4s", len(json_bytes), b"JSON")
    binary_header = struct.pack("<I4s", len(binary), b"BIN\x00")
    return header + json_header + bytes(json_bytes) + binary_header + bytes(binary)


def main():
    if sc.doc is None or sc.doc.Objects.Count == 0:
        Rhino.UI.Dialogs.ShowMessageBox("Open a Rhino model with geometry before running this exporter.", "FacadeScan")
        return
    unit_scale = Rhino.RhinoMath.UnitScale(sc.doc.ModelUnitSystem, Rhino.UnitSystem.Meters)
    if unit_scale <= 0:
        Rhino.UI.Dialogs.ShowMessageBox("Set the Rhino document units to a known unit system before exporting.", "FacadeScan")
        return

    folder_dialog = FolderBrowserDialog()
    folder_dialog.Description = "Choose a folder for the FacadeScan model export."
    if folder_dialog.ShowDialog() != DialogResult.OK:
        return
    output_folder = folder_dialog.SelectedPath
    model_name = os.path.splitext(os.path.basename(text(sc.doc.Name or "rhino_model.3dm")))[0]
    model_name = re.sub(r"[^A-Za-z0-9._-]+", "_", model_name) or "rhino_model"

    exported = []
    records = {}
    skipped = []
    used_names = set()
    for obj in sc.doc.Objects:
        if obj is None or obj.IsDeleted or not obj.Attributes.Visible:
            continue
        geometry = obj.Geometry
        mesh = mesh_geometry(geometry)
        if mesh is None:
            skipped.append(text(obj.Id))
            continue

        object_name = text(obj.Attributes.Name or "").strip()
        if not object_name:
            object_name = "Object_" + text(obj.Id).replace("-", "")[:16]
        if object_name in used_names:
            object_name = object_name + "_" + text(obj.Id).replace("-", "")[:8]
        used_names.add(object_name)

        layer_name, category, layer_direction = layer_info(obj)
        source_normal = dominant_surface_normal(geometry, mesh)
        if source_normal is None:
            source_normal = (0.0, 0.0, 1.0)
        azimuth, geometric_direction = orientation_from_normal(source_normal)
        direction = layer_direction or geometric_direction or "N"
        normal_glb = [round(source_normal[0], 6), round(source_normal[2], 6), round(-source_normal[1], 6)]
        area_m2 = exact_area(geometry, mesh, unit_scale)
        if area_m2 is None or area_m2 <= 0:
            skipped.append(object_name)
            continue

        level_match = LEVEL_RE.search(object_name)
        segment_match = SEGMENT_RE.search(object_name)
        record = {
            "id": text(obj.Id),
            "name": object_name,
            "layer": layer_name,
            "category": category if category != "REFERENCE" else category_from_name(object_name),
            "orientation": direction,
            "geometric_orientation": geometric_direction,
            "geometric_azimuth_deg": azimuth,
            "normal_glb": normal_glb,
            "level": int(level_match.group(1)) if level_match else None,
            "segment": int(segment_match.group(1)) if segment_match else None,
            "exact_area_m2": round(area_m2, 6),
            "mesh_area_m2": None,
            "mesh_minus_exact_m2": None,
            "geometry_type": text(geometry.GetType().Name),
            "status": "MEASURED",
            "in_glb": True,
        }
        records[object_name] = record
        exported.append({"name": object_name, "mesh": mesh, "unit_scale": unit_scale})

    if not exported:
        Rhino.UI.Dialogs.ShowMessageBox("No supported surfaces or meshes were found to export.", "FacadeScan")
        return

    glb_path = os.path.join(output_folder, model_name + ".glb")
    manifest_path = os.path.join(output_folder, model_name + "_manifest.json")
    audit_path = os.path.join(output_folder, model_name + "_audit.json")
    csv_path = os.path.join(output_folder, model_name + "_objects.csv")

    with open(glb_path, "wb") as output:
        output.write(make_gltf(exported))

    counts = {}
    by_orientation = {}
    for record in records.values():
        counts[record["category"]] = counts.get(record["category"], 0) + 1
        direction = record["orientation"]
        if direction not in by_orientation:
            by_orientation[direction] = {"wall_m2": 0.0, "window_m2": 0.0}
        if record["category"] == "WALL":
            by_orientation[direction]["wall_m2"] += record["exact_area_m2"]
        elif record["category"] == "WINDOW":
            by_orientation[direction]["window_m2"] += record["exact_area_m2"]
    for values in by_orientation.values():
        gross = values["wall_m2"] + values["window_m2"]
        values["gross_facade_m2"] = gross
        values["wwr"] = values["window_m2"] / gross if gross else None
        for key in ("wall_m2", "window_m2", "gross_facade_m2"):
            values[key] = round(values[key], 5)

    with open(manifest_path, "w") as output:
        output.write(json.dumps({"model": os.path.basename(glb_path), "unit": "m", "objects": records}, indent=2))
    audit = {
        "source_3dm": text(sc.doc.Name),
        "total_objects": len(records),
        "csv_measured": len(records),
        "glb_mesh_nodes": len(exported),
        "category_counts": counts,
        "by_orientation": by_orientation,
        "unmeshed_or_unsupported_objects": skipped,
        "warning": "Review category, orientation, matching, conditioned-envelope scope, and material assumptions before ETTV use.",
    }
    with open(audit_path, "w") as output:
        output.write(json.dumps(audit, indent=2))
    csv_columns = ("name", "layer", "category", "level", "segment", "orientation", "exact_area_m2", "geometry_type", "id")
    def csv_cell(value):
        value = "" if value is None else text(value)
        return '"' + value.replace('"', '""') + '"'
    csv_lines = [",".join(csv_cell(value) for value in csv_columns)]
    for record in records.values():
        csv_lines.append(",".join(csv_cell(record[key]) for key in csv_columns))
    with open(csv_path, "wb") as output:
        output.write(("\r\n".join(csv_lines) + "\r\n").encode("utf-8"))

    Rhino.UI.Dialogs.ShowMessageBox(
        "FacadeScan export created:\n\n%s\n%s\n%s\n\nMeshable objects: %s\nSkipped objects: %s\n\nSelect the GLB and both JSON files together in the FacadeScan import page. Review layer categories and façade directions before using ETTV." %
        (glb_path, manifest_path, audit_path, len(exported), len(skipped)),
        "FacadeScan export complete"
    )


if __name__ == "__main__":
    main()
