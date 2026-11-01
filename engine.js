// Moteur de conseils : aucun accès à l'écran ni au stockage, uniquement des calculs testables.
// Eau : bilan hydrique journalier FAO-56 (évapotranspiration × coefficient cultural, réserve utile du sol).
// Calendrier : dates de gel calculées sur 15 ans d'historique météo du lieu.
(function (root) {
  const { PLANTS, FAM } = typeof module !== "undefined" ? require("./plants.js") : root.Plants;

  /* ---------- Dates ISO ---------- */

  const toUTC = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  const fromUTC = (t) => new Date(t).toISOString().slice(0, 10);
  const addDays = (iso, n) => fromUTC(toUTC(iso) + n * 864e5);
  const diffDays = (a, b) => Math.round((toUTC(a) - toUTC(b)) / 864e5);
  const yearOf = (iso) => +iso.slice(0, 4);
  const doy = (iso) => diffDays(iso, yearOf(iso) + "-01-01");
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const percentile = (arr, q) => {
    const s = [...arr].sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.round(q * (s.length - 1)))] : null;
  };
  const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  /* ---------- Sol ---------- */

  // Réserve utile en mm par mètre de sol (FAO-56, tableau 19) et infiltration quotidienne maximale.
  const SOILS = {
    sable: { n: "Sableuse", d: "Ne se tient pas en boudin, file entre les doigts", taw: 80, infil: 90 },
    sablo: { n: "Sablo-limoneuse", d: "Fait une boule fragile, sans boudin", taw: 130, infil: 60 },
    limon: { n: "Limoneuse (franche)", d: "Fait un boudin qui casse si on le plie", taw: 155, infil: 40 },
    limoneuse: { n: "Limon fin", d: "Douce comme du talc, boudin fragile", taw: 170, infil: 30 },
    argilo: { n: "Argilo-limoneuse", d: "Boudin qui se plie un peu puis se fissure", taw: 155, infil: 25 },
    argile: { n: "Argileuse", d: "Boudin qui fait un anneau, colle aux doigts", taw: 160, infil: 18 },
  };
  const HUMUS = { faible: { n: "Pauvre", taw: 0.92 }, moyen: { n: "Moyen", taw: 1 }, riche: { n: "Riche, sol noir", taw: 1.12 } };
  const DRAIN = { mauvais: { n: "Mauvais, flaques après la pluie", infil: 0.5 }, moyen: { n: "Normal", infil: 1 }, bon: { n: "Rapide", infil: 1.3 } };
  const IRRIG = { arrosoir: { n: "Arrosoir", eff: 0.85 }, tuyau: { n: "Tuyau, jet", eff: 0.7 }, aspersion: { n: "Asperseur", eff: 0.75 }, goutte: { n: "Goutte-à-goutte", eff: 0.95 } };
  const SUN = { plein: { n: "Plein soleil", d: "6 h de soleil ou plus", et: 1, rank: 2 }, mi: { n: "Mi-ombre", d: "3 à 6 h de soleil", et: 0.8, rank: 1 }, ombre: { n: "Ombre", d: "Moins de 3 h de soleil", et: 0.6, rank: 0 } };
  const WIND = { abrite: { n: "Abrité", et: 0.95 }, normal: { n: "Normal", et: 1 }, expose: { n: "Exposé", et: 1.12 } };
  const SITU = { ville: { n: "Ville ou mur abritant", days: -3 }, campagne: { n: "Campagne", days: 5 }, cuvette: { n: "Fond de vallée, cuvette", days: 12 } };

  function soilReserve(soil) {
    const base = SOILS[soil.texture] || SOILS.limon;
    const humus = HUMUS[soil.humus] || HUMUS.moyen;
    const stones = clamp((soil.stones ?? 0) / 100, 0, 0.7);
    return {
      taw: base.taw * humus.taw * (1 - stones),
      infil: base.infil * (DRAIN[soil.drainage] || DRAIN.moyen).infil,
      depth: soil.depth || 1,
    };
  }

  // Convertit les proportions argile, sable, limon en classe de texture simplifiée.
  function textureFromFractions(clay, sand) {
    if (clay >= 40) return "argile";
    if (clay >= 27) return "argilo";
    if (sand >= 80) return "sable";
    if (sand >= 50) return "sablo";
    if (sand <= 20) return "limoneuse";
    return "limon";
  }

  // Les cartes de sol n'ont pas de données en ville : on cherche alors le point le plus proche, en cercles de plus en plus larges.
  function soilProbeRings(lat, lon) {
    const kmLat = 1 / 111, kmLon = 1 / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
    const rings = [{ km: 0, points: [{ lat, lon }] }];
    for (const km of [2, 4, 7, 10, 15, 20, 30, 45]) {
      const points = [];
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        points.push({ lat: +(lat + km * kmLat * Math.sin(a)).toFixed(5), lon: +(lon + km * kmLon * Math.cos(a)).toFixed(5) });
      }
      rings.push({ km, points });
    }
    return rings;
  }

  function soilMapURL(property, { lat, lon }) {
    const d = 0.002, layers = ["0-5cm", "5-15cm", "15-30cm"].map((depth) => `${property}_${depth}_mean`).join(",");
    return `https://maps.isric.org/mapserv?map=/map/${property}.map&SERVICE=WMS&VERSION=1.1.1&REQUEST=GetFeatureInfo&LAYERS=${layers}&QUERY_LAYERS=${layers}&STYLES=`
      + `&SRS=EPSG:4326&BBOX=${(lon - d).toFixed(5)},${(lat - d).toFixed(5)},${(lon + d).toFixed(5)},${(lat + d).toFixed(5)}&WIDTH=3&HEIGHT=3&X=1&Y=1&FEATURE_COUNT=3&INFO_FORMAT=application/geo%2Bjson`;
  }

  // Le serveur colle une réponse par couche, ce qui n'est pas du JSON valide : on lit donc directement les valeurs.
  function soilMapMean(text) {
    const values = [...String(text).matchAll(/"pixel_value"\s*:\s*(-?\d+(?:\.\d+)?)/g)].map((m) => +m[1]).filter((v) => v > 0);
    return mean(values);
  }

  /* ---------- Climat ---------- */

  const MILD_TEMP = 9.5;

  // Résume 15 ans de relevés : gel, zone de rusticité, normales. sd = jour de saison (décalé dans l'hémisphère sud).
  function climateFromArchive(daily, lat) {
    const shift = lat < 0 ? 183 : 0;
    const sd = (iso) => (doy(iso) + shift) % 366;
    const mid = 196;
    const seasons = {};
    const months = Array.from({ length: 12 }, () => ({ tmax: [], tmin: [], rain: {}, et0: {} }));
    const byDay = Array.from({ length: 366 }, () => []);
    const yearMin = {};
    daily.time.forEach((iso, i) => {
      const tmin = daily.temperature_2m_min[i], tmax = daily.temperature_2m_max[i];
      if (tmin == null || tmax == null) return;
      const y = yearOf(iso), s = sd(iso), season = lat < 0 && doy(iso) < 183 ? y - 1 : y;
      const rec = seasons[season] || (seasons[season] = { last: null, first: null, days: 0 });
      rec.days++;
      if (tmin <= 0) {
        if (s < mid) rec.last = s;
        else if (rec.first == null) rec.first = s;
      }
      yearMin[season] = Math.min(yearMin[season] ?? 99, tmin);
      const m = months[+iso.slice(5, 7) - 1];
      m.tmax.push(tmax); m.tmin.push(tmin);
      m.rain[y] = (m.rain[y] || 0) + (daily.precipitation_sum[i] || 0);
      m.et0[y] = (m.et0[y] || 0) + (daily.et0_fao_evapotranspiration[i] || 0);
      byDay[doy(iso)].push((tmin + tmax) / 2);
    });
    const full = Object.values(seasons).filter((r) => r.days > 340);
    const lasts = full.filter((r) => r.last != null).map((r) => r.last);
    const firsts = full.filter((r) => r.first != null).map((r) => r.first);
    const frostFree = lasts.length < full.length / 2;
    const extreme = mean(Object.keys(seasons).filter((k) => seasons[k].days > 340).map((k) => yearMin[k]));
    const raw = byDay.map((v) => mean(v));
    const normals = raw.map((_, i) => {
      const w = [];
      for (let k = -7; k <= 7; k++) { const v = raw[(i + k + 366) % 366]; if (v != null) w.push(v); }
      return +(mean(w) ?? 10).toFixed(1);
    });
    // Sans gel, la saison démarre quand il fait assez doux : la date de gel seule mettrait la tomate dehors en février.
    const seasonal = Array.from({ length: 366 }, (_, s) => normals[(s - shift + 366) % 366]);
    let warmFrom = seasonal.findIndex((t, s) => s > 20 && s < mid && t >= MILD_TEMP);
    if (warmFrom < 0) warmFrom = 32;
    let warmTo = mid;
    while (warmTo < 365 && seasonal[warmTo] >= MILD_TEMP) warmTo++;
    const later = (v) => Math.max(v ?? 0, warmFrom);
    return {
      lat, shift, years: full.length, frostFree,
      lfMed: frostFree ? warmFrom : percentile(lasts, 0.5),
      lfSafe: later(frostFree ? 0 : percentile(lasts, 0.8)),
      ffMed: frostFree || !firsts.length ? warmTo : percentile(firsts, 0.5),
      ffEarly: frostFree || !firsts.length ? warmTo : percentile(firsts, 0.2),
      extreme: extreme == null ? null : +extreme.toFixed(1),
      months: months.map((m) => ({
        tmax: +(mean(m.tmax) ?? 0).toFixed(1), tmin: +(mean(m.tmin) ?? 0).toFixed(1),
        rain: Math.round(mean(Object.values(m.rain)) ?? 0), et0: Math.round(mean(Object.values(m.et0)) ?? 0),
      })),
      normals,
    };
  }

  function hardinessZone(extreme) {
    if (extreme == null) return null;
    const f = extreme * 9 / 5 + 32;
    const z = clamp(Math.floor((f + 60) / 10) + 1, 1, 13);
    return z + ((f + 60) % 10 < 5 ? "a" : "b");
  }

  const sdToISO = (clim, sd, year) => addDays(year + "-01-01", ((sd - clim.shift) % 366 + 366) % 366);

  // Dates de gel de l'année, corrigées selon le microclimat et un éventuel abri.
  function frostDates(clim, year, garden, covered) {
    const situ = (SITU[garden && garden.situation] || { days: 0 }).days;
    const cover = covered ? 21 : 0;
    return {
      lf: addDays(sdToISO(clim, clim.lfSafe, year), situ - cover),
      ff: addDays(sdToISO(clim, clim.ffEarly, year), -situ + cover),
      lfMed: addDays(sdToISO(clim, clim.lfMed, year), situ - cover),
      ffMed: addDays(sdToISO(clim, clim.ffMed, year), -situ + cover),
    };
  }

  function seasonLength(clim, garden) {
    const y = 2025, f = frostDates(clim, y, garden, false);
    return clim.frostFree ? 365 : ((diffDays(f.ffMed, f.lfMed) % 365) + 365) % 365;
  }

  // Toutes les fenêtres d'une méthode autour d'une année, triées.
  function windowsFor(plant, method, clim, year, garden, covered) {
    const list = (plant.win && plant.win[method]) || [];
    const out = [];
    for (let y = year - 1; y <= year + 1; y++) {
      const f = frostDates(clim, y, garden, covered);
      for (const [a, b, ref] of list) {
        const base = ref === "lf" ? f.lf : f.ff;
        out.push({ from: addDays(base, a * 7), to: addDays(base, b * 7) });
      }
    }
    out.sort((x, y) => (x.from < y.from ? -1 : 1));
    // Fusionne les fenêtres qui se chevauchent, par exemple l'automne et le début de printemps des arbres.
    return out.reduce((acc, w) => {
      const last = acc[acc.length - 1];
      if (last && w.from <= addDays(last.to, 1)) { if (w.to > last.to) last.to = w.to; } else acc.push({ ...w });
      return acc;
    }, []);
  }

  const inWindow = (wins, iso) => wins.find((w) => w.from <= iso && iso <= w.to) || null;
  const nextWindow = (wins, iso) => wins.find((w) => w.from > iso) || null;

  // Douze cases par méthode, pour dessiner le calendrier annuel de la plante.
  function yearCalendar(plant, clim, garden, year) {
    const res = {};
    for (const method of Object.keys(plant.win || {})) {
      const wins = windowsFor(plant, method, clim, year, garden, false);
      res[method] = Array.from({ length: 12 }, (_, m) => {
        const a = `${year}-${String(m + 1).padStart(2, "0")}-01`;
        const b = addDays(`${m === 11 ? year + 1 : year}-${String(m === 11 ? 1 : m + 2).padStart(2, "0")}-01`, -1);
        return wins.some((w) => w.from <= b && a <= w.to);
      });
    }
    return res;
  }

  /* ---------- Météo ---------- */

  // Ramène la réponse Open-Meteo à une ligne par jour, facile à garder hors ligne.
  function dailyFromForecast(json) {
    const d = json.daily, h = json.hourly, hourly = {};
    (h ? h.time : []).forEach((t, i) => {
      const key = t.slice(0, 10), r = hourly[key] || (hourly[key] = { soilT: [], soilM: [], wet: 0 });
      if (h.soil_temperature_6cm[i] != null) r.soilT.push(h.soil_temperature_6cm[i]);
      if (h.soil_moisture_3_to_9cm[i] != null) r.soilM.push(h.soil_moisture_3_to_9cm[i]);
      if (h.relative_humidity_2m[i] >= 90 && h.temperature_2m[i] >= 10 && h.temperature_2m[i] <= 25) r.wet++;
    });
    // Le service de prévision ne remonte pas toujours jusqu'au bout de past_days : ces jours arrivent vides.
    return d.time.map((iso, i) => (d.temperature_2m_min[i] == null || d.temperature_2m_max[i] == null ? null : {
      d: iso, tmin: d.temperature_2m_min[i], tmax: d.temperature_2m_max[i],
      rain: d.precipitation_sum[i] ?? 0, prob: d.precipitation_probability_max[i],
      et0: d.et0_fao_evapotranspiration[i] ?? 0, rad: d.shortwave_radiation_sum[i], wind: d.wind_speed_10m_max[i], gust: d.wind_gusts_10m_max[i],
      uv: d.uv_index_max[i], code: d.weather_code[i], rise: d.sunrise[i] && d.sunrise[i].slice(11), set: d.sunset[i] && d.sunset[i].slice(11),
      soilT: hourly[iso] && mean(hourly[iso].soilT), soilM: hourly[iso] && mean(hourly[iso].soilM), wet: hourly[iso] ? hourly[iso].wet : 0,
    })).filter(Boolean);
  }

  // Relevés d'archive pour combler le début de l'historique.
  function dailyFromArchive(json) {
    const d = json.daily;
    return d.time.map((iso, i) => (d.temperature_2m_min[i] == null || d.temperature_2m_max[i] == null ? null : {
      d: iso, tmin: d.temperature_2m_min[i], tmax: d.temperature_2m_max[i], rain: d.precipitation_sum[i] ?? 0, prob: null,
      et0: d.et0_fao_evapotranspiration[i] ?? 0, code: d.weather_code[i], wind: d.wind_speed_10m_max[i], wet: 0,
    })).filter(Boolean);
  }

  // Plage à demander à l'archive pour avoir assez d'historique, ou null s'il ne manque rien.
  function missingHistory(weather, today, days) {
    const need = addDays(today, -days);
    const first = weather.length ? weather[0].d : today;
    return first > need ? { from: need, to: addDays(first, -1) } : null;
  }

  // Fusionne la nouvelle réponse dans l'historique : on garde jusqu'à 400 jours de relevés.
  function mergeWeather(old, fresh) {
    const map = new Map((old || []).map((r) => [r.d, r]));
    fresh.forEach((r) => map.set(r.d, r));
    return [...map.values()].sort((a, b) => (a.d < b.d ? -1 : 1)).slice(-400);
  }

  const WMO = {
    0: ["☀️", "Grand soleil"], 1: ["🌤️", "Plutôt dégagé"], 2: ["⛅", "Éclaircies"], 3: ["☁️", "Couvert"], 45: ["🌫️", "Brouillard"], 48: ["🌫️", "Brouillard givrant"],
    51: ["🌦️", "Bruine légère"], 53: ["🌦️", "Bruine"], 55: ["🌦️", "Bruine dense"], 56: ["🌧️", "Bruine verglaçante"], 57: ["🌧️", "Bruine verglaçante"],
    61: ["🌧️", "Pluie faible"], 63: ["🌧️", "Pluie"], 65: ["🌧️", "Forte pluie"], 66: ["🌧️", "Pluie verglaçante"], 67: ["🌧️", "Pluie verglaçante"],
    71: ["🌨️", "Neige faible"], 73: ["🌨️", "Neige"], 75: ["🌨️", "Forte neige"], 77: ["🌨️", "Grains de neige"],
    80: ["🌦️", "Averses"], 81: ["🌦️", "Averses"], 82: ["⛈️", "Fortes averses"], 85: ["🌨️", "Averses de neige"], 86: ["🌨️", "Averses de neige"],
    95: ["⛈️", "Orage"], 96: ["⛈️", "Orage et grêle"], 99: ["⛈️", "Orage et grêle"],
  };
  const weatherLabel = (code) => WMO[code] || ["🌡️", "Temps variable"];

  /* ---------- Culture ---------- */

  const areaOf = (p) => Math.max(0.01, (p.w || 1) * (p.h || 1));
  const isIndoors = (p) => p.method === "abri";
  const plantOf = (p) => PLANTS[p.plant];

  // Une culture est sous abri si on l'indique ou si elle est posée dans une serre du plan.
  function isCovered(p, garden) {
    if (p.covered) return true;
    const cx = (p.x || 0) + (p.w || 0) / 2, cy = (p.y || 0) + (p.h || 0) / 2;
    return (garden.zones || []).some((z) => z.type === "serre" && cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h);
  }

  function stageOf(plant, age) {
    const [a, b, c, d] = plant.st;
    if (age < a) return { key: "ini", n: "Démarrage", kc: plant.kc[0] };
    if (age < a + b) return { key: "dev", n: "Croissance", kc: plant.kc[0] + (plant.kc[1] - plant.kc[0]) * (age - a) / b };
    if (age < a + b + c) return { key: "mid", n: "Pleine production", kc: plant.kc[1] };
    if (age < a + b + c + d) return { key: "late", n: "Fin de cycle", kc: plant.kc[1] + (plant.kc[2] - plant.kc[1]) * (age - a - b - c) / d };
    return { key: "end", n: "Cycle terminé", kc: plant.kc[2] };
  }

  // Les vivaces repartent chaque printemps : leur âge de saison se compte depuis le dernier gel.
  function kcFor(plant, planting, iso, day, clim, garden) {
    const age = diffDays(iso, planting.date);
    if (plant.vivace && age > 180 && clim) {
      const spring = frostDates(clim, yearOf(iso), garden, false).lfMed;
      const seasonAge = diffDays(iso, spring);
      const total = plant.st.reduce((a, b) => a + b, 0);
      if (seasonAge < 0 || seasonAge > total) return { key: "rest", n: "Repos", kc: 0.2 };
      return stageOf(plant, seasonAge);
    }
    return stageOf(plant, age);
  }

  // Profondeur de racines : petite au semis, maximale en fin de croissance.
  function rootDepth(plant, planting, age, soil) {
    const start = planting.method === "semis" ? 0.08 : plant.arbre ? plant.root * 0.3 : 0.15;
    const grow = plant.arbre ? 1095 : plant.st[0] + plant.st[1];
    const z = start + (plant.root - start) * clamp(age / grow, 0, 1);
    return Math.max(0.08, Math.min(z, soil.depth || 1));
  }

  // Les jeunes arbres n'occupent qu'une partie de leur emplacement.
  function wetFraction(plant, age) {
    return plant.arbre ? clamp(0.08 + 0.14 * age / 365, 0, 0.9) : 1;
  }

  const MAX_WATERING_MM = 25;
  const effectiveRain = (r, et0, infil) => (r < Math.max(1, 0.2 * et0) ? 0 : Math.min(r, infil));

  /**
   * Bilan hydrique quotidien d'une culture.
   * Déficit dr en mm : 0 = sol à sa capacité. Il faut arroser quand dr dépasse raw, la réserve facile.
   */
  function waterBalance(planting, garden, weather, clim, today) {
    const plant = plantOf(planting);
    if (!plant || !weather.length || isIndoors(planting) || planting.date > today || planting.endDate) return null;
    const soil = soilReserve(garden.soil || {});
    const covered = isCovered(planting, garden);
    const sunF = (SUN[planting.sun || garden.sun] || SUN.plein).et;
    const windF = covered ? 0.95 : (WIND[garden.wind] || WIND.normal).et;
    const mulchF = planting.mulch ? 0.85 : 1;
    const coverF = covered ? 0.7 : 1;
    const slopeF = garden.slope === "forte" ? 0.7 : garden.slope === "legere" ? 0.9 : 1;
    const eff = (IRRIG[planting.irrigation] || IRRIG.arrosoir).eff;
    const start = planting.date >= weather[0].d ? planting.date : weather[0].d;
    const truncated = planting.date < weather[0].d;
    const waters = {};
    (planting.waterings || []).forEach((w) => { waters[w.date] = (waters[w.date] || 0) + w.l; });

    let dr = null, today_ = null;
    const series = [];
    for (const day of weather) {
      if (day.d < start) continue;
      const age = diffDays(day.d, planting.date);
      const stage = kcFor(plant, planting, day.d, day, clim, garden);
      const fraction = wetFraction(plant, age);
      const area = areaOf(planting) * fraction;
      const zr = rootDepth(plant, planting, age, soil);
      const taw = soil.taw * zr;
      const et = stage.kc * day.et0 * sunF * windF * mulchF * coverF;
      let p = plant.p + 0.04 * (5 - et);
      if (age < 21 && !plant.arbre) p = Math.min(p, 0.35);
      const raw = clamp(p, 0.1, 0.8) * taw;
      if (dr == null) dr = truncated ? raw * 0.5 : 0;
      const future = day.d > today;
      let rain = covered ? 0 : effectiveRain(day.rain, day.et0, soil.infil * slopeF);
      if (future) rain *= day.prob == null ? 0.5 : clamp(day.prob / 100, 0, 1);
      const irr = (waters[day.d] || 0) * eff / area;
      dr = clamp(dr + et - rain - irr, 0, taw);
      const row = { d: day.d, dr, taw, raw, et, rain, irr, area, kc: stage.kc, stage: stage.key, stageName: stage.n, future };
      series.push(row);
      if (day.d === today) today_ = row;
    }
    if (!today_) return null;

    const reserve = clamp(1 - today_.dr / today_.taw, 0, 1);
    const needs = today_.dr >= today_.raw;
    const upcoming = series.filter((r) => r.future);
    const nextHit = upcoming.find((r) => r.dr >= r.raw);
    // Au-delà de 25 L/m² d'un coup, l'eau s'enfonce trop vite : le reste passera au prochain arrosage.
    const litres = Math.max(1, Math.round(Math.min(today_.dr, MAX_WATERING_MM) * today_.area / eff));
    const rainSoon = weather.filter((d) => d.d > today && d.d <= addDays(today, 2)).reduce((sum, d) => sum + (covered ? 0 : effectiveRain(d.rain, d.et0, soil.infil * slopeF) * (d.prob == null ? 0.5 : d.prob >= 60 ? 1 : 0)), 0);
    const wait = needs && rainSoon >= today_.dr * 0.6 && today_.dr < today_.taw * 0.75;
    return {
      series, today: today_, reserve, needs, wait, litres, rainSoon, eff, covered,
      nextIn: needs ? 0 : nextHit ? diffDays(nextHit.d, today) : null,
      stage: today_.stageName, stageKey: today_.stage,
    };
  }

  // Maturité : on avance plus vite quand il fait bon, on utilise la prévision puis les normales du lieu.
  function harvestEstimate(planting, weather, clim) {
    const plant = plantOf(planting);
    if (!plant) return null;
    const direct = planting.method === "semis";
    const [dMin, dMax] = direct ? plant.d : plant.dp || plant.d;
    if (!plant.gr || !clim) return { from: addDays(planting.date, dMin), to: addDays(planting.date, dMax) };
    const [base, opt] = plant.gr;
    // Les durées annoncées par les catalogues correspondent à une saison normale : pleine vitesse dès 70 % de l'optimum.
    const full = (opt - base) * 0.7;
    const byDate = new Map(weather.map((r) => [r.d, (r.tmin + r.tmax) / 2]));
    let sum = 0, from = null, iso = planting.date;
    for (let i = 0; i < 500; i++) {
      const t = byDate.has(iso) ? byDate.get(iso) : clim.normals[Math.min(365, doy(iso))];
      sum += clamp((t - base) / full, plant.tmin < -1 ? 0.2 : 0.05, 1);
      if (from == null && sum >= dMin) from = iso;
      if (sum >= dMax) break;
      iso = addDays(iso, 1);
    }
    const start = from || iso;
    // Une plante gélive n'ira pas au-delà du premier gel : on le signale plutôt que d'annoncer une récolte l'an prochain.
    if (plant.tmin >= -1 && !plant.vivace && !planting.covered && !clim.frostFree) {
      const fall = frostDates(clim, yearOf(planting.date), null, false).ffMed;
      const limit = fall < planting.date ? frostDates(clim, yearOf(planting.date) + 1, null, false).ffMed : fall;
      if (start > limit) return { from: start, to: iso, late: true, limit };
      if (iso > limit) return { from: start, to: limit };
    }
    return { from: start, to: iso };
  }

  /* ---------- Plan ---------- */

  function polygonArea(pts) {
    let a = 0;
    pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; });
    return Math.abs(a) / 2;
  }

  function pointInPolygon(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  const rectInside = (r, pts) => [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h], [r.x + r.w / 2, r.y + r.h / 2]].every(([x, y]) => pointInPolygon(x, y, pts));
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  // Distance entre deux rectangles, 0 s'ils se touchent.
  const rectDist = (a, b) => Math.hypot(Math.max(0, a.x - b.x - b.w, b.x - a.x - a.w), Math.max(0, a.y - b.y - b.h, b.y - a.y - a.h));

  const obstacles = (garden, plantings, skipId, date) => [
    ...(garden.zones || []).filter((z) => z.type !== "serre"),
    ...plantings.filter((p) => p.id !== skipId && !p.endDate && !isIndoors(p) && p.w),
  ];

  // Cherche le premier emplacement libre pour un rectangle, le plus près de l'angle haut gauche.
  function findFreeSpot(garden, plantings, w, h, skipId) {
    const pts = garden.shape;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const step = Math.max(0.1, Math.min(0.5, Math.min(w, h) / 2));
    const blocked = obstacles(garden, plantings, skipId);
    for (let y = minY; y + h <= maxY + 1e-6; y += step) {
      for (let x = minX; x + w <= maxX + 1e-6; x += step) {
        const r = { x: +x.toFixed(2), y: +y.toFixed(2), w, h };
        if (rectInside(r, pts) && !blocked.some((o) => overlap(r, o))) return r;
      }
    }
    return null;
  }

  // Taille conseillée d'une parcelle pour un nombre de plants.
  function suggestSize(plant, count) {
    const n = Math.max(1, count || 1);
    const cols = Math.max(1, Math.round(Math.sqrt(n * plant.rang / plant.esp)));
    const rows = Math.ceil(n / cols);
    return { w: +Math.max(0.3, cols * plant.esp).toFixed(2), h: +Math.max(0.3, rows * plant.rang).toFixed(2) };
  }

  const capacity = (plant, w, h) => Math.max(1, Math.floor((w + 1e-6) / plant.esp) * Math.floor((h + 1e-6) / plant.rang) || 1);

  /* ---------- Puis-je planter ? ---------- */

  const METHODS = { semis: "Semis en pleine terre", abri: "Semis à l'abri", plant: "Mise en terre de plants" };
  const fmt = (iso) => new Date(toUTC(iso)).toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: "UTC" });

  function canPlant({ plantKey, method, date, garden, weather, clim, plantings, place, covered }) {
    const plant = PLANTS[plantKey];
    const checks = [];
    const add = (level, title, detail) => checks.push({ level, title, detail });
    const year = yearOf(date);
    const outdoors = method !== "abri";

    // Calendrier local.
    const wins = windowsFor(plant, method, clim, year, garden, covered);
    const current = inWindow(wins, date);
    const next = nextWindow(wins, date);
    if (current) add("ok", "C'est la bonne période", `Fenêtre pour ton jardin : du ${fmt(current.from)} au ${fmt(current.to)}.`);
    else if (next) add("block", "Pas la bonne période", `La prochaine fenêtre pour ton jardin va du ${fmt(next.from)} au ${fmt(next.to)}.`);
    else add("block", "Méthode déconseillée", `${METHODS[method]} n'est pas adapté à cette plante.`);

    if (outdoors) {
      const near = diffDays(date, weather.length ? weather[weather.length - 1].d : date) <= 0;
      const horizon = weather.filter((d) => d.d >= date && d.d <= addDays(date, 10));
      const recent = weather.filter((d) => d.d <= date && d.d >= addDays(date, -3));
      const soilTs = recent.map((d) => d.soilT).filter((v) => v != null);
      const soilT = soilTs.length ? mean(soilTs) : null;

      if (near && soilT != null) {
        const need = method === "semis" ? plant.germ : Math.max(plant.germ - 3, 3);
        if (soilT < 1) add("block", "Sol gelé", "Attends le dégel pour travailler la terre.");
        else if (soilT < need - 3) add("block", "Sol trop froid", `Le sol est à ${soilT.toFixed(0)} °C. Il lui faut au moins ${need} °C.`);
        else if (soilT < need) add("warn", "Sol encore frais", `Le sol est à ${soilT.toFixed(0)} °C pour ${need} °C conseillés : la reprise sera lente.`);
        else add("ok", "Température du sol", `${soilT.toFixed(0)} °C, ça convient (${need} °C minimum).`);
        if (method === "semis" && plant.germMax && soilT > plant.germMax) add("warn", "Sol trop chaud", `Au-dessus de ${plant.germMax} °C, la germination est difficile. Sème le soir et garde frais.`);
      }

      if (horizon.length) {
        const cold = horizon.reduce((a, b) => (b.tmin < a.tmin ? b : a));
        if (!covered && cold.tmin <= plant.tmin) add("block", "Gel annoncé", `${cold.tmin.toFixed(0)} °C prévus le ${fmt(cold.d)}, et cette plante ne tient pas sous ${plant.tmin} °C.`);
        else if (covered && cold.tmin <= plant.tmin - 3) add("warn", "Nuit froide sous abri", `${cold.tmin.toFixed(0)} °C prévus le ${fmt(cold.d)} : ajoute un voile d'hivernage.`);
        else add("ok", "Pas de gel dangereux", `Minimum prévu : ${cold.tmin.toFixed(0)} °C sur 10 jours.`);
        const hot = horizon.reduce((a, b) => (b.tmax > a.tmax ? b : a));
        if (hot.tmax >= 32) add("warn", "Forte chaleur annoncée", `${hot.tmax.toFixed(0)} °C le ${fmt(hot.d)} : plante le soir et ombre les premiers jours.`);
      }

      const wet = recent.reduce((s, d) => s + (d.rain || 0), 0);
      const heavy = ["argile", "argilo"].includes(garden.soil.texture);
      if (!covered && wet >= (heavy ? 15 : 30)) add("warn", "Sol détrempé", `${wet.toFixed(0)} mm tombés ces 3 derniers jours : attends que la terre s'émiette.`);

      // Temps restant avant le gel pour les plantes gélives.
      const isFlower = plant.rdt === 0 && plant.cat === "fleur";
      const event = isFlower ? "floraison" : "récolte";
      if (plant.tmin >= -1 && !plant.vivace && !clim.frostFree) {
        const est = harvestEstimate({ plant: plantKey, method, date }, weather, clim);
        const fall = frostDates(clim, yearOf(date), garden, covered).ffMed;
        const f = fall < date ? frostDates(clim, yearOf(date) + 1, garden, covered).ffMed : fall;
        if (est && (est.late || est.from > f) && current) add("warn", "Saison un peu courte", `Première ${event} estimée après les premiers gels (${fmt(f)}).`);
        else if (est && current) add("ok", "Temps de culture suffisant", `Première ${event} estimée vers le ${fmt(est.from)}.`);
      } else if (plant.rdt > 0 || isFlower) {
        const est = harvestEstimate({ plant: plantKey, method, date }, weather, clim);
        if (est) add("info", `${isFlower ? "Floraison" : "Récolte"} estimée`, `Vers le ${fmt(est.from)}.`);
      }

      if (plant.vivace && clim.extreme != null && !covered) {
        if (clim.extreme < plant.tmin - 3) add("block", "Trop froid en hiver chez toi", `Les hivers descendent vers ${clim.extreme.toFixed(0)} °C, cette plante tient jusqu'à ${plant.tmin} °C.`);
        else if (clim.extreme < plant.tmin) add("warn", "Rusticité limite", `Les hivers descendent vers ${clim.extreme.toFixed(0)} °C : protège-la ou choisis un coin abrité.`);
      }

      // Sol.
      const soil = garden.soil || {};
      const avoid = plant.eviter || [];
      if (soil.ph != null && plant.ph) {
        if (soil.ph < plant.ph[0] - 0.7 || soil.ph > plant.ph[1] + 0.7) add("block", "pH inadapté", `Ton sol est à pH ${soil.ph}, elle préfère ${plant.ph[0]} à ${plant.ph[1]}.`);
        else if (soil.ph < plant.ph[0]) add("warn", "Sol un peu acide", `pH ${soil.ph} pour ${plant.ph[0]} à ${plant.ph[1]} : ajoute un peu de cendre ou de chaux.`);
        else if (soil.ph > plant.ph[1]) add("warn", "Sol un peu calcaire", `pH ${soil.ph} pour ${plant.ph[0]} à ${plant.ph[1]} : apporte du compost bien mûr.`);
        else add("ok", "pH adapté", `${soil.ph}, dans sa plage de ${plant.ph[0]} à ${plant.ph[1]}.`);
      } else if (plant.ph) add("info", "pH inconnu", `Elle préfère ${plant.ph[0]} à ${plant.ph[1]}. Un test de pH rendra ce conseil plus fiable.`);

      const tex = soil.texture;
      if (avoid.includes("argile") && ["argile", "argilo"].includes(tex)) add("warn", "Terre lourde", plant.racine ? "Les racines risquent de fourcher : ameublis profondément et ajoute du sable." : "Allège la terre avec du compost et du sable.");
      if (avoid.includes("sable") && ["sable"].includes(tex)) add("warn", "Terre très légère", "Elle retient mal l'eau et les éléments : ajoute beaucoup de compost.");
      if (avoid.includes("pierres") && (soil.stones || 0) >= 20) add("warn", "Terre caillouteuse", "Les racines vont se déformer : retire les cailloux sur 30 cm ou cultive en butte.");
      if (avoid.includes("humide") && soil.drainage === "mauvais") add("warn", "Mauvais drainage", "Elle craint l'excès d'eau : plante-la sur butte.");
      if (avoid.includes("calcaire") && soil.ph != null && soil.ph > 7.3) add("warn", "Terre calcaire", "Elle la supporte mal : apporte de la terre de bruyère.");
      if ((soil.depth || 1) < plant.root * 0.6) add("warn", "Sol peu profond", `Ses racines vont à ${Math.round(plant.root * 100)} cm, ton sol à ${Math.round(soil.depth * 100)} cm.`);
      if (plant.besoin === "fort" && soil.humus === "faible") add("warn", "Sol pauvre pour cette plante", "Elle est gourmande : incorpore 3 à 5 L de compost par m².");

      // Lumière.
      const site = SUN[(place && place.sun) || garden.sun] || SUN.plein;
      const need = SUN[plant.sun] || SUN.plein;
      if (site.rank + 1 < need.rank) add("block", "Pas assez de soleil", `Elle demande ${need.n.toLowerCase()}, ton emplacement est à l'${site.n.toLowerCase()}.`);
      else if (site.rank < need.rank) add("warn", "Soleil un peu juste", `Elle préfère ${need.n.toLowerCase()} : la récolte sera moindre.`);
      else add("ok", "Lumière", `${site.n}, ça lui convient.`);

      // Emplacement, voisins et rotation.
      const active = plantings.filter((p) => !p.endDate && !isIndoors(p) && p.w);
      if (place) {
        const near_ = active.filter((p) => p.id !== place.id && rectDist(place, p) <= 1);
        const foes = near_.filter((p) => (plant.ennemis || []).includes(p.plant) || (PLANTS[p.plant].ennemis || []).includes(plantKey));
        const friends = near_.filter((p) => (plant.amis || []).includes(p.plant) || (PLANTS[p.plant].amis || []).includes(plantKey));
        if (foes.length) add("warn", "Voisin peu apprécié", `${[...new Set(foes.map((p) => PLANTS[p.plant].n))].join(", ")} à moins d'un mètre : éloigne-les si tu peux.`);
        if (friends.length) add("ok", "Bon voisinage", `${[...new Set(friends.map((p) => PLANTS[p.plant].n))].join(", ")} à proximité.`);
        const yearsNeeded = (FAM[plant.f] || {}).rot || 0;
        if (yearsNeeded) {
          const limit = addDays(date, -yearsNeeded * 365);
          const past = plantings.filter((p) => p.id !== place.id && p.w && p.date >= limit && p.date <= date && PLANTS[p.plant] && PLANTS[p.plant].f === plant.f && overlap(place, p));
          if (past.length) add("warn", "Rotation à revoir", `${PLANTS[past[0].plant].n} (même famille) a poussé ici en ${yearOf(past[0].date)}. Attends ${yearsNeeded} ans ou change de place.`);
          else add("ok", "Rotation", `Pas de culture de la même famille ici depuis ${yearsNeeded} ans.`);
        }
      } else if (garden.shape) {
        const size = suggestSize(plant, 1);
        if (!findFreeSpot(garden, plantings, size.w, size.h)) add("warn", "Plus de place libre", "Termine une culture ou agrandis ton plan.");
      }
    } else {
      add("info", "À l'abri", "Mets en godets, près d'une fenêtre lumineuse ou sous serre, entre 18 et 25 °C pour les plantes de chaleur.");
    }

    const severity = { block: 0, warn: 1, ok: 2, info: 3 };
    checks.sort((a, b) => severity[a.level] - severity[b.level]);
    const blocked = checks.some((c) => c.level === "block");
    const warned = checks.some((c) => c.level === "warn");
    return {
      verdict: blocked ? "non" : warned ? "prudence" : "oui",
      checks, method, window: current, next,
    };
  }

  // Évalue toutes les méthodes possibles et retient la meilleure.
  function bestMethod(args) {
    const plant = PLANTS[args.plantKey];
    const results = Object.keys(plant.win || {}).map((method) => canPlant({ ...args, method }));
    const rank = { oui: 0, prudence: 1, non: 2 };
    const order = { plant: 0, semis: 1, abri: 2 };
    results.sort((a, b) => rank[a.verdict] - rank[b.verdict] || order[a.method] - order[b.method]);
    return results[0];
  }

  // Ce qu'on peut lancer maintenant, méthode par méthode.
  function plantNow({ date, garden, weather, clim, plantings }) {
    const out = [];
    for (const key of Object.keys(PLANTS)) {
      const best = bestMethod({ plantKey: key, date, garden, weather, clim, plantings });
      if (best.verdict !== "non") out.push({ key, ...best });
    }
    return out;
  }

  /* ---------- Conseils du jour ---------- */

  function dailyAdvice({ today, garden, weather, clim, plantings }) {
    const list = [];
    const push = (a) => list.push(a);
    const next = weather.filter((d) => d.d >= today && d.d <= addDays(today, 7));
    const tomorrow = next.slice(0, 3);
    const active = plantings.filter((p) => !p.endDate && plantOf(p) && p.date <= today);

    for (const p of active) {
      const plant = plantOf(p), label = plant.n + (p.variety ? ` ${p.variety}` : "");
      if (isIndoors(p)) {
        const wins = windowsFor(plant, "plant", clim, yearOf(today), garden, false);
        const cur = inWindow(wins, today), nxt = nextWindow(wins, today);
        if (cur) push({ kind: "repiquer", urgency: 2, id: p.id, icon: "🌱", title: `${label} : prêt à repiquer`, detail: `La fenêtre de mise en terre est ouverte jusqu'au ${fmt(cur.to)}.` });
        else if (nxt && diffDays(nxt.from, today) <= 21) push({ kind: "info", urgency: 0, id: p.id, icon: "🌱", title: `${label} : repiquage bientôt`, detail: `À partir du ${fmt(nxt.from)}. Garde le terreau juste humide.` });
        continue;
      }
      const wb = waterBalance(p, garden, weather, clim, today);
      if (wb && wb.needs && !wb.wait) push({ kind: "eau", urgency: wb.today.dr > wb.today.taw * 0.75 ? 3 : 2, id: p.id, litres: wb.litres, icon: "💧", title: `Arrose : ${label}`, detail: `Environ ${wb.litres} L, le matin de préférence, sans mouiller le feuillage. Réserve du sol à ${Math.round(wb.reserve * 100)} %.` });
      if (wb && wb.wait) push({ kind: "info", urgency: 1, id: p.id, icon: "🌧️", title: `${label} : attends la pluie`, detail: `Le sol a soif, mais ${wb.rainSoon.toFixed(0)} mm sont attendus sous 48 h.` });

      const est = harvestEstimate(p, weather, clim);
      const harvested = (p.harvests || []).length > 0;
      if (est && est.late) {
        if (today >= est.limit) push({ kind: "fin", urgency: 0, id: p.id, icon: "🥶", title: `${label} : fin de saison`, detail: "Le froid arrête cette culture. Clôture-la pour garder le plan et la rotation à jour." });
      } else if (est && plant.rdt > 0) {
        if (today >= est.from && today <= addDays(est.to, 21) && !plant.arbre) push({ kind: "recolte", urgency: 1, id: p.id, icon: plant.e, title: `${label} : ${harvested ? "récolte en cours" : "récolte possible"}`, detail: `Période estimée jusqu'au ${fmt(est.to)}.` });
        else if (!harvested && !plant.vivace && diffDays(est.from, today) > 0 && diffDays(est.from, today) <= 7) push({ kind: "info", urgency: 0, id: p.id, icon: plant.e, title: `${label} : récolte dans quelques jours`, detail: `Vers le ${fmt(est.from)}.` });
      }
      if (!plant.vivace && est && !est.late && today > addDays(est.to, 45)) push({ kind: "fin", urgency: 0, id: p.id, icon: "🧺", title: `${label} : culture terminée ?`, detail: "Clôture-la pour libérer la place sur le plan et garder la rotation à jour." });

      const age = diffDays(today, p.date);
      for (const [day, text] of plant.soins || []) {
        if (age >= day && age < day + 7) push({ kind: "soin", urgency: 1, id: p.id, icon: "✂️", title: label, detail: text });
      }
    }

    const planted = active.filter((p) => !isIndoors(p));
    const outside = planted.filter((p) => !isCovered(p, garden));

    // Gel : on cite les plantes réellement menacées.
    const coldDay = next.length ? next.slice(0, 5).reduce((a, b) => (b.tmin < a.tmin ? b : a)) : null;
    if (coldDay) {
      const hit = outside.filter((p) => coldDay.tmin <= plantOf(p).tmin + 1);
      if (hit.length) push({ kind: "alerte", urgency: 4, icon: "🥶", title: `Gel : ${coldDay.tmin.toFixed(0)} °C prévus ${dayName(coldDay.d, today)}`, detail: `Protège avec un voile d'hivernage : ${names(hit)}.` });
      else if (coldDay.tmin <= 0 && planted.length) push({ kind: "info", urgency: 0, icon: "❄️", title: `Gel ${dayName(coldDay.d, today)} (${coldDay.tmin.toFixed(0)} °C)`, detail: "Tes cultures en place le supportent. Évite d'arroser le soir." });
    }
    const hotDay = next.length ? next.slice(0, 5).reduce((a, b) => (b.tmax > a.tmax ? b : a)) : null;
    if (hotDay && hotDay.tmax >= 32 && planted.length) push({ kind: "alerte", urgency: 3, icon: "🥵", title: `Canicule : ${hotDay.tmax.toFixed(0)} °C ${dayName(hotDay.d, today)}`, detail: "Arrose tôt le matin, paille le sol et ombre les semis et les salades." });
    const windy = tomorrow.find((d) => (d.gust || d.wind || 0) >= 60);
    if (windy && planted.length) push({ kind: "alerte", urgency: 2, icon: "💨", title: `Vent fort ${dayName(windy.d, today)}`, detail: `Rafales à ${Math.round(windy.gust || windy.wind)} km/h : vérifie les tuteurs et les voiles.` });
    const storm = tomorrow.find((d) => d.code === 96 || d.code === 99);
    if (storm && planted.length) push({ kind: "alerte", urgency: 3, icon: "⛈️", title: `Risque de grêle ${dayName(storm.d, today)}`, detail: "Couvre ce qui est fragile si tu peux." });

    // Maladies, à partir des heures humides et tièdes.
    const window3 = weather.filter((d) => d.d >= addDays(today, -1) && d.d <= addDays(today, 2));
    const wetDays = window3.filter((d) => d.wet >= 9).length;
    const mil = outside.filter((p) => plantOf(p).mildiou);
    if (wetDays >= 2 && mil.length) push({ kind: "maladie", urgency: 2, icon: "🍂", title: "Risque de mildiou", detail: `Humidité et douceur réunies. Inspecte ${names(mil)} et retire les feuilles tachées.` });
    const oid = outside.filter((p) => plantOf(p).oidium);
    const dryWarm = weather.filter((d) => d.d >= addDays(today, -3) && d.d <= today && d.tmax >= 22 && d.tmax <= 32 && d.rain < 1);
    if (dryWarm.length >= 3 && wetDays >= 1 && oid.length) push({ kind: "maladie", urgency: 1, icon: "🍂", title: "Conditions à oïdium", detail: `Surveille le dessus des feuilles de ${names(oid)}.` });
    const recentRain = weather.filter((d) => d.d >= addDays(today, -3) && d.d <= today).reduce((s, d) => s + d.rain, 0);
    const todayW = weather.find((d) => d.d === today);
    const young = outside.filter((p) => diffDays(today, p.date) < 30 && !plantOf(p).arbre);
    if (recentRain >= 5 && todayW && (todayW.tmin + todayW.tmax) / 2 > 7 && young.length) push({ kind: "maladie", urgency: 1, icon: "🐌", title: "Temps à limaces", detail: `Protège les jeunes pousses : ${names(young)}.` });

    if (!planted.length) push({ kind: "info", urgency: 0, icon: "🌱", title: "Ton jardin est vide pour l'instant", detail: "Va dans Planter pour voir ce que tu peux lancer maintenant." });
    return list.sort((a, b) => b.urgency - a.urgency);
  }

  const names = (list) => [...new Set(list.map((p) => plantOf(p).n.toLowerCase()))].join(", ");
  function dayName(iso, today) {
    const n = diffDays(iso, today);
    if (n <= 0) return "aujourd'hui";
    if (n === 1) return "demain";
    return new Date(toUTC(iso)).toLocaleDateString("fr-FR", { weekday: "long", timeZone: "UTC" });
  }

  // Bilan sur les derniers jours : pluie reçue contre évaporation.
  function hydricSummary(weather, today, days) {
    const list = weather.filter((d) => d.d <= today && d.d > addDays(today, -days));
    const rain = list.reduce((s, d) => s + (d.rain || 0), 0), et0 = list.reduce((s, d) => s + (d.et0 || 0), 0);
    return { rain, et0, balance: rain - et0 };
  }

  const api = {
    addDays, diffDays, yearOf, doy, clamp, mean, fmt,
    SOILS, HUMUS, DRAIN, IRRIG, SUN, WIND, SITU, METHODS,
    soilReserve, textureFromFractions, soilProbeRings, soilMapURL, soilMapMean, climateFromArchive, hardinessZone, frostDates, seasonLength,
    windowsFor, inWindow, nextWindow, yearCalendar,
    dailyFromForecast, dailyFromArchive, missingHistory, mergeWeather, weatherLabel,
    areaOf, isIndoors, isCovered, plantOf, stageOf, waterBalance, harvestEstimate,
    polygonArea, pointInPolygon, rectInside, overlap, rectDist, findFreeSpot, suggestSize, capacity,
    canPlant, bestMethod, plantNow, dailyAdvice, hydricSummary,
  };
  root.Engine = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof self !== "undefined" ? self : this);
