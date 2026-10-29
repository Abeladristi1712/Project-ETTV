import { calculateBuilding, glazingPresets, opaquePresets } from './ettv-engine.js';

export function findMaterialRecommendations(geometry, shadingScenarios, target = 45, limit = 12) {
  const walls = opaquePresets.filter((preset) => Number.isFinite(preset.value));
  const glazing = glazingPresets.flatMap((preset) => {
    if (typeof preset.value !== 'string') return [];
    const [uf, scGlass] = preset.value.split('|').map(Number);
    return Number.isFinite(uf) && Number.isFinite(scGlass) ? [{ ...preset, uf, scGlass }] : [];
  });
  const tested = [];

  for (const wall of walls) {
    for (const glass of glazing) {
      for (const scenario of shadingScenarios) {
        const settings = Object.fromEntries(Object.keys(geometry).map((direction) => [
          direction,
          {
            uw: wall.value,
            uf: glass.uf,
            scGlass: glass.scGlass,
            hpr: 0,
            vpr: 0,
            ...(scenario.settingsByOrientation[direction] ?? {})
          }
        ]));
        const result = calculateBuilding(geometry, settings);
        if (result.overall === null) continue;
        const estimated = result.facades.some((facade) => facade.area > 0 && facade.estimated);
        tested.push({
          wall,
          glass,
          scenario,
          ettv: result.overall,
          estimated
        });
      }
    }
  }

  const eligible = tested.filter((candidate) => !candidate.estimated);
  const matches = eligible
    .filter((candidate) => candidate.ettv <= target)
    .sort((a, b) => (target - a.ettv) - (target - b.ettv))
    .slice(0, limit);
  const closest = [...eligible].sort((a, b) => a.ettv - b.ettv)[0] ?? null;
  return {
    tested: tested.length,
    estimated: tested.filter((candidate) => candidate.estimated).length,
    matches,
    closest
  };
}
