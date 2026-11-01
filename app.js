// Interface de l'app. Tout reste sur le téléphone : seules les coordonnées du jardin partent vers les services météo et sol.
(() => {
  const E = window.Engine;
  const { PLANTS, FAM, CATS } = window.Plants;
  const KEY = "jardin.v1";
  const TABS = ["jour", "plan", "cultures", "planter", "jardin"];
  const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
  const MONTH_NAMES = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
  const MONTH_SHORT = ["Janv.", "Févr.", "Mars", "Avr.", "Mai", "Juin", "Juil.", "Août", "Sept.", "Oct.", "Nov.", "Déc."];
  const WEATHER_MAX_AGE = 60 * 60 * 1000;
  const HISTORY_DAYS = 180;
  const ZONES = {
    allee: { n: "Allée", e: "🚶", c: "#b9a78c" }, terrasse: { n: "Terrasse", e: "🪑", c: "#a9a9a9" }, cabane: { n: "Cabane", e: "🏠", c: "#b98a64" },
    serre: { n: "Serre", e: "🏡", c: "#a7e3f5" }, bassin: { n: "Bassin", e: "💧", c: "#7cc4ff" }, compost: { n: "Compost", e: "♻️", c: "#8a7a55" }, arbre: { n: "Arbre existant", e: "🌳", c: "#6bb37f" },
  };

  const $ = (id) => document.getElementById(id);
  const main = $("main"), sheet = $("sheet"), toastEl = $("toast");
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const num = (v, d = 1) => v == null || Number.isNaN(v) ? "—" : (+v).toFixed(d).replace(".", ",").replace(/,0+$/, "");
  const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
  const shortDate = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "short" });

  const emptyState = () => ({
    garden: {
      name: "Mon jardin", place: "", lat: null, lon: null, elevation: null, situation: "campagne", sun: "plein", wind: "normal", slope: "plat", north: 0,
      soil: { texture: "limon", humus: "moyen", stones: 5, depth: 0.8, drainage: "moyen", ph: null, calcaire: false }, soilAuto: null,
      shapeKind: "rect", dims: { w: 10, h: 8, cutW: 4, cutH: 3 }, shape: rectShape(10, 8), zones: [],
    },
    plantings: [], weather: [], current: null, clim: null, weatherAt: 0, setupDone: false,
  });
  function rectShape(w, h) { return [[0, 0], [w, 0], [w, h], [0, h]]; }
  function lShape({ w, h, cutW, cutH }) { return [[0, 0], [w, 0], [w, h - cutH], [w - cutW, h - cutH], [w - cutW, h], [0, h]]; }

  let S = load();
  let tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "jour";
  let setupStep = 0, setupError = "", placeResults = [];
  let selected = null, shapeMode = false, overlay = "cultures", view = null;
  let filter = { q: "", cat: "tout" };
  let loadingWeather = false, weatherError = "";
  let advisor = null, nowCache = null;

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY));
      if (raw && raw.garden) return raw;
    } catch (e) {}
    return emptyState();
  }
  function save() {
    nowCache = null;
    try { localStorage.setItem(KEY, JSON.stringify(S)); }
    catch (e) { toast("Mémoire du téléphone pleine : exporte une sauvegarde.", true); }
  }

  let toastTimer;
  function toast(msg, bad) {
    const t = toastEl;
    t.textContent = msg; t.className = "glass" + (bad ? " bad" : ""); t.hidden = false;
    // Une fenêtre ouverte passe devant tout le reste de la page : le message doit s'afficher au-dessus d'elle.
    if (t.showPopover) { if (t.matches(":popover-open")) t.hidePopover(); t.showPopover(); }
    else if (sheet.open) sheet.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (t.showPopover && t.matches(":popover-open")) t.hidePopover();
      t.hidden = true;
    }, 4200);
  }

  /* ---------- Services ---------- */

  async function getJSON(url, tries = 3) {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(url);
        if (res.ok) return await res.json();
        last = new Error("HTTP " + res.status);
        if (res.status < 500 && res.status !== 429) break;
      } catch (e) { last = e; }
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
    throw last;
  }

  async function refreshWeather(force) {
    const g = S.garden;
    if (g.lat == null || loadingWeather) return;
    if (!force && Date.now() - S.weatherAt < WEATHER_MAX_AGE && S.clim) return;
    loadingWeather = true; weatherError = ""; renderHeader();
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}`
        + "&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,wind_speed_10m,weather_code"
        + "&hourly=temperature_2m,relative_humidity_2m,soil_temperature_6cm,soil_moisture_3_to_9cm"
        + "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,et0_fao_evapotranspiration,shortwave_radiation_sum,wind_speed_10m_max,wind_gusts_10m_max,uv_index_max,sunrise,sunset,weather_code"
        + "&past_days=92&forecast_days=14&timezone=auto";
      const json = await getJSON(url);
      S.weather = E.mergeWeather(S.weather, E.dailyFromForecast(json));
      await fillHistory();
      S.current = json.current;
      if (g.elevation == null) g.elevation = json.elevation;
      S.weatherAt = Date.now();
      if (!S.clim) await refreshClimate();
      save();
    } catch (e) {
      weatherError = navigator.onLine === false ? "Hors ligne" : "Météo indisponible";
    }
    loadingWeather = false;
    render();
  }

  // Le bilan d'eau a besoin de plusieurs mois de relevés. Sans archive, il repart simplement de plus près.
  async function fillHistory() {
    const gap = E.missingHistory(S.weather, todayISO(), HISTORY_DAYS);
    if (!gap) return;
    const g = S.garden;
    try {
      const json = await getJSON(`https://archive-api.open-meteo.com/v1/archive?latitude=${g.lat}&longitude=${g.lon}&start_date=${gap.from}&end_date=${gap.to}`
        + "&daily=temperature_2m_min,temperature_2m_max,precipitation_sum,et0_fao_evapotranspiration,weather_code,wind_speed_10m_max&timezone=auto", 2);
      S.weather = E.mergeWeather(E.dailyFromArchive(json), S.weather);
    } catch (e) {}
  }

  async function refreshClimate() {
    const g = S.garden, y = new Date().getFullYear() - 1;
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${g.lat}&longitude=${g.lon}&start_date=${y - 14}-01-01&end_date=${y}-12-31`
      + "&daily=temperature_2m_min,temperature_2m_max,precipitation_sum,et0_fao_evapotranspiration&timezone=auto";
    const json = await getJSON(url);
    S.clim = E.climateFromArchive(json.daily, g.lat);
  }

  // Estimation mondiale à 250 m : pratique pour démarrer, moins fiable qu'un test à la main.
  async function soilValue(property, point) {
    let last;
    for (let i = 0; i < 2; i++) {
      try {
        const res = await fetch(E.soilMapURL(property, point));
        if (res.ok) return E.soilMapMean(await res.text());
        last = new Error("HTTP " + res.status);
      } catch (e) { last = e; }
    }
    throw last;
  }

  async function fetchSoil() {
    const g = S.garden;
    for (const ring of E.soilProbeRings(g.lat, g.lon)) {
      const found = await Promise.allSettled(ring.points.map((p) => soilValue("clay", p)));
      if (found.every((r) => r.status === "rejected")) throw new Error("service");
      const i = found.findIndex((r) => r.status === "fulfilled" && r.value != null);
      if (i < 0) continue;
      const point = ring.points[i];
      const [sand, ph, soc] = await Promise.all(["sand", "phh2o", "soc"].map((p) => soilValue(p, point)));
      if (sand == null) continue;
      return { clay: found[i].value / 10, sand: sand / 10, ph: ph == null ? null : ph / 10, soc: soc == null ? null : soc / 10, km: ring.km };
    }
    throw new Error("vide");
  }

  /* ---------- Rendu général ---------- */

  function renderHeader() {
    const done = S.setupDone;
    $("title").textContent = done ? S.garden.name || "Mon jardin" : "Mon jardin";
    $("tabs").hidden = !done;
    $("refresh").hidden = !done;
    $("refresh").disabled = loadingWeather;
    let text = "";
    if (done) {
      if (loadingWeather) text = "Mise à jour de la météo…";
      else if (S.weatherAt) {
        const when = new Date(S.weatherAt).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
        text = weatherError ? `${weatherError}, relevé du ${when}` : `${S.garden.place || "Ton jardin"}, météo de ${when}`;
      } else text = weatherError || S.garden.place;
    } else text = "On configure ton jardin en 4 étapes";
    $("sync").textContent = text;
    const i = TABS.indexOf(tab);
    $("tabs").style.setProperty("--i", i);
    document.querySelectorAll("#tabs button").forEach((b) => {
      if (b.dataset.tab === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
  }

  function render() {
    renderHeader();
    if (!S.setupDone) { main.innerHTML = setupView(); afterRender(); return; }
    main.innerHTML = { jour: jourView, plan: planView, cultures: culturesView, planter: planterView, jardin: jardinView }[tab]();
    afterRender();
  }

  function afterRender() {
    if ($("plan")) initPlan();
    const days = main.querySelector(".days");
    if (days) days.scrollLeft = 0;
  }

  const waiting = () => `<section class="glass panel stack"><h2>${loadingWeather ? "La météo arrive" : "Météo indisponible"}</h2><p class="muted">${loadingWeather ? "Je récupère les prévisions et 15 ans d'historique de ton lieu. Ça prend quelques secondes." : "Il me faut une connexion une première fois pour calculer tes conseils."}</p>${loadingWeather ? "" : '<button class="primary" type="button" data-act="refresh">Réessayer</button>'}</section>`;
  const ready = () => S.weather.length && S.clim;
  const active = () => S.plantings.filter((p) => !p.endDate && E.plantOf(p));
  const opts = (map, val) => Object.entries(map).map(([k, v]) => `<option value="${k}"${k === String(val) ? " selected" : ""}>${esc(v.n)}${v.d ? " : " + esc(v.d) : ""}</option>`).join("");

  /* ---------- Configuration en 4 étapes ---------- */

  function setupView() {
    const bar = `<div class="steps" aria-label="Étape ${setupStep + 1} sur 4">${[0, 1, 2, 3].map((i) => `<i class="${i <= setupStep ? "on" : ""}"></i>`).join("")}</div>`;
    const back = setupStep ? '<button class="soft" type="button" data-act="setupBack">Retour</button>' : "";
    const nextLabel = setupStep === 3 ? "Terminer" : "Continuer";
    const canNext = setupStep > 0 || S.garden.lat != null;
    const foot = `<div class="row between">${back || "<span></span>"}<button class="primary" type="button" data-act="setupNext"${canNext ? "" : " disabled"}>${nextLabel}</button></div>`;
    const body = [placeForm, soilForm, siteForm, shapeForm][setupStep]();
    return `<section class="glass panel stack">${bar}${body}${setupError ? `<p class="form-error">${esc(setupError)}</p>` : ""}${foot}</section>`;
  }

  function placeForm() {
    const g = S.garden;
    return `<h2>Où est ton jardin ?</h2>
      <p class="muted">Pour la météo en direct et le climat de ton coin. Ta position reste dans l'app et n'est envoyée qu'au service météo.</p>
      <button class="primary wide" type="button" data-act="geolocate">📍 Utiliser ma position</button>
      <div class="field"><label for="placeSearch">Ou cherche ta commune</label><input id="placeSearch" type="search" autocomplete="off" placeholder="Lille, Annecy, Brest…" value=""></div>
      <div id="placeResults" class="results">${placeResultsHTML()}</div>
      ${g.lat != null ? `<p>✓ <b>${esc(g.place)}</b> <span class="muted small">(${g.lat.toFixed(3)}, ${g.lon.toFixed(3)})</span></p>` : ""}`;
  }
  const placeResultsHTML = () => placeResults.map((r, i) => `<button class="result" type="button" data-act="pickPlace" data-i="${i}"><b>${esc(r.name)}</b> <span class="muted small">${esc([r.admin2, r.admin1, r.country].filter(Boolean).join(", "))}</span></button>`).join("");

  function soilForm() {
    const s = S.garden.soil, a = S.garden.soilAuto;
    return `<h2>Ta terre</h2>
      <p class="muted">Humidifie une poignée de terre et roule-la en boudin : c'est le test le plus fiable.</p>
      <div class="field"><label for="f-texture">Type de terre</label><select id="f-texture" data-set="soil.texture">${opts(E.SOILS, s.texture)}</select></div>
      <button class="soft" type="button" data-act="soilAuto">🛰️ Estimer depuis les cartes de sol</button>
      <div id="soilAutoMsg" class="hint" role="status">${a ? `Estimation : ${num(a.clay, 0)} % d'argile, ${num(a.sand, 0)} % de sable${a.ph ? `, pH ${num(a.ph)}` : ""}${a.km ? `. Ton adresse est en zone urbaine sur la carte : valeurs relevées à environ ${a.km} km, à confirmer par le test du boudin` : ""}.` : ""}</div>
      <div class="two">
        <div class="field"><label for="f-ph">pH, si tu le connais</label><input id="f-ph" type="number" inputmode="decimal" step="0.1" min="3.5" max="9.5" placeholder="Inconnu" data-set="soil.ph" data-type="num" value="${s.ph ?? ""}"></div>
        <div class="field"><label for="f-humus">Matière organique</label><select id="f-humus" data-set="soil.humus">${opts(E.HUMUS, s.humus)}</select></div>
      </div>
      <div class="two">
        <div class="field"><label for="f-stones">Cailloux (%)</label><input id="f-stones" type="number" inputmode="numeric" min="0" max="70" data-set="soil.stones" data-type="num" value="${s.stones}"></div>
        <div class="field"><label for="f-depth">Profondeur de terre (cm)</label><input id="f-depth" type="number" inputmode="numeric" min="10" max="200" data-set="soil.depth" data-type="cm" value="${Math.round(s.depth * 100)}"></div>
      </div>
      <div class="field"><label for="f-drain">Drainage</label><select id="f-drain" data-set="soil.drainage">${opts(E.DRAIN, s.drainage)}</select></div>`;
  }

  function siteForm() {
    const g = S.garden;
    return `<h2>Son exposition</h2>
      <div class="field"><label for="f-sun">Ensoleillement général</label><select id="f-sun" data-set="sun">${opts(E.SUN, g.sun)}</select></div>
      <div class="field"><label for="f-wind">Vent</label><select id="f-wind" data-set="wind">${opts(E.WIND, g.wind)}</select></div>
      <div class="field"><label for="f-situ">Situation</label><select id="f-situ" data-set="situation" data-reset="1">${opts(E.SITU, g.situation)}</select><span class="hint">Un fond de vallée gèle plus tard au printemps : le calendrier s'ajuste.</span></div>
      <div class="field"><label for="f-slope">Pente</label><select id="f-slope" data-set="slope">${opts({ plat: { n: "Plat" }, legere: { n: "Légère" }, forte: { n: "Forte" } }, g.slope)}</select></div>
      <div class="field"><label for="f-north">Où est le nord sur ton plan ?</label><select id="f-north" data-set="north" data-type="num">${[[0, "En haut"], [90, "À droite"], [180, "En bas"], [270, "À gauche"]].map(([v, t]) => `<option value="${v}"${v === +g.north ? " selected" : ""}>${t}</option>`).join("")}</select></div>`;
  }

  function shapeForm() {
    const g = S.garden, d = g.dims, kind = g.shapeKind;
    const area = E.polygonArea(g.shape);
    const dims = kind === "free"
      ? '<p class="hint">Glisse les points blancs. Touche un petit point sur un côté pour ajouter un angle. Un côté passe au vert quand il est bien droit.</p>'
      : `<div class="two">
          <div class="field"><label for="d-w">Largeur (m)</label><input id="d-w" type="number" inputmode="decimal" min="1" step="0.5" data-dim="w" value="${d.w}"></div>
          <div class="field"><label for="d-h">Longueur (m)</label><input id="d-h" type="number" inputmode="decimal" min="1" step="0.5" data-dim="h" value="${d.h}"></div>
          ${kind === "l" ? `<div class="field"><label for="d-cw">Largeur de l'encoche (m)</label><input id="d-cw" type="number" inputmode="decimal" min="0.5" step="0.5" data-dim="cutW" value="${d.cutW}"></div>
          <div class="field"><label for="d-ch">Longueur de l'encoche (m)</label><input id="d-ch" type="number" inputmode="decimal" min="0.5" step="0.5" data-dim="cutH" value="${d.cutH}"></div>` : ""}
        </div>`;
    return `<h2>Forme et surface</h2>
      <div class="chips" role="group" aria-label="Forme">
        ${[["rect", "Rectangle"], ["l", "En L"], ["free", "Forme libre"]].map(([k, t]) => `<button class="chip" type="button" data-act="shapeKind" data-kind="${k}" aria-pressed="${k === kind}">${t}</button>`).join("")}
      </div>
      ${dims}
      <div class="row between"><b id="areaLabel">${num(area)} m²</b>
        <button class="ghost" type="button" data-act="scaleArea">Ajuster à une surface exacte</button></div>
      ${planCanvas(true)}`;
  }

  async function geolocate() {
    if (!navigator.geolocation) { setupError = "Ton navigateur ne donne pas la position. Cherche ta commune."; return render(); }
    toast("Recherche de ta position…");
    navigator.geolocation.getCurrentPosition(async (pos) => {
      setPlace(+pos.coords.latitude.toFixed(4), +pos.coords.longitude.toFixed(4), "Ma position");
    }, (err) => {
      setupError = err.code === 1 ? "Position refusée. Cherche plutôt ta commune." : "Position introuvable. Cherche plutôt ta commune.";
      render();
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  }

  function setPlace(lat, lon, name, elevation) {
    const g = S.garden;
    const moved = g.lat !== lat || g.lon !== lon;
    g.lat = lat; g.lon = lon; g.place = name; g.elevation = elevation ?? null;
    if (moved) { S.clim = null; S.weather = []; S.current = null; S.weatherAt = 0; g.soilAuto = null; }
    setupError = ""; placeResults = [];
    save(); render();
    if (S.setupDone) { closeSheet(); refreshWeather(true); }
  }

  let searchTimer;
  function searchPlace(q) {
    clearTimeout(searchTimer);
    if (q.trim().length < 2) { placeResults = []; updatePlaceResults(); return; }
    searchTimer = setTimeout(async () => {
      try {
        const json = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q.trim())}&count=6&language=fr&format=json`, 1);
        placeResults = json.results || [];
        setupError = placeResults.length ? "" : "";
        updatePlaceResults(placeResults.length ? "" : "Aucune commune trouvée.");
      } catch (e) { updatePlaceResults("Recherche indisponible. Vérifie ta connexion."); }
    }, 300);
  }
  function updatePlaceResults(msg) {
    const box = $("placeResults");
    if (box) box.innerHTML = msg ? `<p class="hint">${esc(msg)}</p>` : placeResultsHTML();
  }

  /* ---------- Onglet Jour ---------- */

  function jourView() {
    if (!ready()) return waiting();
    const today = todayISO(), c = S.current, w = S.weather.find((d) => d.d === today) || S.weather[S.weather.length - 1];
    const [ico, label] = E.weatherLabel(c ? c.weather_code : w.code);
    const advice = E.dailyAdvice({ today, garden: S.garden, weather: S.weather, clim: S.clim, plantings: S.plantings });
    const days = S.weather.filter((d) => d.d >= today).slice(0, 14);
    const sum7 = E.hydricSummary(S.weather, today, 7);
    return `<section class="glass panel">
        <div class="weather-now"><div class="weather-icon" aria-hidden="true">${ico}</div>
          <div class="grow"><div class="temp">${c ? Math.round(c.temperature_2m) : "—"}°</div>
          <div class="muted">${esc(label)}, ${Math.round(w.tmin)}° à ${Math.round(w.tmax)}°</div></div></div>
        <div class="tiles">
          <div class="tile"><b>${num(w.rain)} mm</b><span>pluie du jour${w.prob != null ? `, ${w.prob} %` : ""}</span></div>
          <div class="tile"><b>${num(w.et0)} mm</b><span>évaporation du jour</span></div>
          <div class="tile"><b>${c ? Math.round(c.wind_speed_10m) : "—"} km/h</b><span>vent</span></div>
          <div class="tile"><b>${w.soilT != null ? Math.round(w.soilT) + " °C" : "—"}</b><span>sol à 6 cm</span></div>
          <div class="tile"><b>${c ? c.relative_humidity_2m + " %" : "—"}</b><span>humidité de l'air</span></div>
          <div class="tile"><b>${w.rise || "—"}</b><span>lever, coucher ${w.set || "—"}</span></div>
        </div>
        <div class="days" tabindex="0" aria-label="Prévisions sur 14 jours">${days.map(dayCard).join("")}</div>
      </section>
      <section class="glass panel"><h2>À faire aujourd'hui</h2>${adviceList(advice)}</section>
      <section class="glass panel stack"><h2>Eau du jardin</h2>
        <div class="tiles" style="margin-top:0">
          <div class="tile"><b>${num(sum7.rain, 0)} mm</b><span>pluie sur 7 jours</span></div>
          <div class="tile"><b>${num(sum7.et0, 0)} mm</b><span>évaporation sur 7 jours</span></div>
          <div class="tile"><b>${sum7.balance > 0 ? "+" : ""}${num(sum7.balance, 0)} mm</b><span>bilan sur 7 jours</span></div>
        </div>
        ${waterChart(today)}
      </section>`;
  }

  function dayCard(d) {
    const label = new Date(d.d + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "short" }).replace(".", "");
    const [ico, text] = E.weatherLabel(d.code);
    return `<div class="day"><b>${d.d === todayISO() ? "Auj." : esc(label)}</b><span class="ico" role="img" aria-label="${esc(text)}">${ico}</span><div>${Math.round(d.tmax)}°</div><div class="muted">${Math.round(d.tmin)}°</div><div class="rain">${d.rain >= 0.5 ? num(d.rain, 0) + " mm" : "&nbsp;"}</div></div>`;
  }

  function adviceList(advice) {
    if (!advice.length) return '<p class="muted">Rien à signaler : ton jardin n\'a besoin de rien aujourd\'hui. 🌿</p>';
    return `<ul class="advice">${advice.map((a) => {
      const hot = a.urgency >= 4;
      const title = a.id ? `<button class="link" type="button" data-act="openCulture" data-id="${a.id}">${esc(a.title)}</button>` : `<b>${esc(a.title)}</b>`;
      let acts = "";
      if (a.kind === "eau") acts = `<div class="acts"><button class="soft" type="button" data-act="waterDone" data-id="${a.id}" data-l="${a.litres}">💧 J'ai arrosé ${a.litres} L</button></div>`;
      if (a.kind === "recolte") acts = `<div class="acts"><button class="soft" type="button" data-act="openCulture" data-id="${a.id}">🧺 Noter une récolte</button></div>`;
      if (a.kind === "repiquer") acts = `<div class="acts"><button class="soft" type="button" data-act="transplant" data-id="${a.id}">🌱 C'est repiqué</button></div>`;
      if (a.kind === "fin") acts = `<div class="acts"><button class="soft" type="button" data-act="endCulture" data-id="${a.id}">Clôturer la culture</button></div>`;
      return `<li><span class="ico" aria-hidden="true">${a.icon}</span><div class="grow"><div class="${hot ? "urgent" : ""}">${title}</div><div class="muted small">${esc(a.detail)}</div>${acts}</div></li>`;
    }).join("")}</ul>`;
  }

  // Pluie en haut, évaporation en bas, même échelle : on voit d'un coup d'œil si le jardin gagne ou perd de l'eau.
  function waterChart(today) {
    const days = S.weather.filter((d) => d.d >= E.addDays(today, -20) && d.d <= E.addDays(today, 7));
    if (!days.length) return "";
    const W = 600, H = 170, mid = 104, bar = Math.max(4, Math.min(14, (W - 40) / days.length - 4));
    const maxUp = Math.max(8, ...days.map((d) => d.rain)), maxDown = Math.max(4, ...days.map((d) => d.et0));
    const upH = mid - 16, downH = H - mid - 22;
    const step = (W - 34) / days.length;
    const marks = days.map((d, i) => {
      const x = 30 + i * step, rainH = d.rain / maxUp * upH, etH = d.et0 / maxDown * downH;
      const tip = `${shortDate(d.d)} : ${num(d.rain)} mm de pluie, ${num(d.et0)} mm d'évaporation${d.d > today ? " (prévision)" : ""}`;
      const dim = d.d > today ? ' opacity=".55"' : "";
      return `<g data-tip="${esc(tip)}"><rect x="${x - step / 2 + bar / 2}" y="6" width="${step}" height="${H - 12}" fill="transparent"/>
        ${rainH > 0.5 ? `<rect x="${x}" y="${mid - 1 - rainH}" width="${bar}" height="${rainH}" rx="3" fill="var(--rain)"${dim}/>` : ""}
        ${etH > 0.5 ? `<rect x="${x}" y="${mid + 1}" width="${bar}" height="${etH}" rx="3" fill="var(--evap)"${dim}/>` : ""}
        <title>${esc(tip)}</title></g>`;
    }).join("");
    const todayIdx = days.findIndex((d) => d.d === today);
    const tx = 30 + todayIdx * step + bar / 2;
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Pluie et évaporation par jour, sur 21 jours passés et 7 jours de prévision">
        <text x="0" y="16" fill="var(--ink-3)" font-size="13">${num(maxUp, 0)} mm</text><text x="0" y="${H - 8}" fill="var(--ink-3)" font-size="13">${num(maxDown, 0)} mm</text>
        <line x1="30" x2="${W}" y1="${mid}" y2="${mid}" stroke="rgba(255,255,255,.25)"/>
        ${todayIdx >= 0 ? `<line x1="${tx}" x2="${tx}" y1="6" y2="${H - 6}" stroke="var(--ink-2)" stroke-dasharray="3 4"/><text x="${tx}" y="${H - 1}" text-anchor="middle" fill="var(--ink-2)" font-size="12">auj.</text>` : ""}
        ${marks}</svg>
      <div class="legend"><span><i style="background:var(--rain)"></i>Pluie</span><span><i style="background:var(--evap)"></i>Évaporation</span><span class="muted">Barres pâles : prévisions</span></div>
      <div id="chartTip" aria-live="polite">Touche une barre pour voir le détail.</div>`;
  }

  /* ---------- Onglet Plan ---------- */

  function planView() {
    const sel = selectedItem();
    const family = overlay === "familles" ? familyLegend() : "";
    const list = overlay === "eau" ? '<div class="legend"><span><i style="background:var(--rain)"></i>Réserve correcte</span><span><i style="background:var(--warn)"></i>Bientôt</span><span><i style="background:var(--ko)"></i>À arroser 💧</span></div>' : "";
    return `<section class="glass panel stack">
        <div class="row between"><h2 style="margin:0">Plan du jardin</h2><span class="muted small">${num(E.polygonArea(S.garden.shape))} m²</span></div>
        <div class="chips" role="group" aria-label="Affichage">
          ${[["cultures", "Cultures"], ["eau", "Besoin d'eau"], ["familles", "Familles"]].map(([k, t]) => `<button class="chip" type="button" data-act="overlay" data-v="${k}" aria-pressed="${overlay === k}">${t}</button>`).join("")}
        </div>
        ${planCanvas(shapeMode)}${list}${family}
        <div id="selPanel">${selPanel(sel)}</div>
        <div class="row">
          <button class="primary grow" type="button" data-act="goPlanter">+ Planter</button>
          <button class="soft grow" type="button" data-act="addZone">+ Élément</button>
          <button class="soft grow" type="button" data-act="toggleShape" aria-pressed="${shapeMode}">${shapeMode ? "✓ Terminer" : "Modifier la forme"}</button>
        </div>
      </section>`;
  }

  const familyLegend = () => {
    const seen = [...new Set(active().map((p) => E.plantOf(p).f))];
    return seen.length ? `<div class="legend">${seen.map((f) => `<span><i style="background:${FAM[f].c}"></i>${esc(FAM[f].n)}</span>`).join("")}</div>` : "";
  };

  function selectedItem() {
    if (!selected) return null;
    return selected.kind === "p" ? S.plantings.find((p) => p.id === selected.id) : (S.garden.zones || []).find((z) => z.id === selected.id);
  }

  function selPanel(item) {
    if (shapeMode) return '<p class="muted small">Glisse les points blancs pour dessiner ton terrain. Touche un petit point sur un côté pour ajouter un angle, ou touche longtemps un angle pour le retirer. Un côté passe au vert quand il est parfaitement horizontal ou vertical.</p>';
    if (!item) return '<p class="muted small">Touche une culture pour la voir. Glisse pour la déplacer, tire le rond pour la redimensionner. Deux doigts pour zoomer.</p>';
    if (selected.kind === "z") {
      const z = ZONES[item.type];
      return `<div class="row between"><b>${z.e} ${esc(z.n)}, ${num(item.w)} × ${num(item.h)} m</b><button class="soft" type="button" data-act="removeZone" data-id="${item.id}">Retirer</button></div>`;
    }
    const plant = E.plantOf(item), today = todayISO();
    const wb = ready() ? E.waterBalance(item, S.garden, S.weather, S.clim, today) : null;
    const inside = E.rectInside(item, S.garden.shape);
    return `<div class="row between"><div class="grow"><b>${plant.e} ${esc(plant.n)}${item.variety ? " " + esc(item.variety) : ""}</b>
        <div class="muted small">${num(item.w)} × ${num(item.h)} m, environ ${item.count} plant${item.count > 1 ? "s" : ""}${wb ? `, ${esc(wateringText(wb))}` : ""}</div>
        ${inside ? "" : '<div class="small" style="color:var(--warn)">Déborde du terrain</div>'}</div>
        <button class="soft" type="button" data-act="openCulture" data-id="${item.id}">Détails</button></div>`;
  }

  function wateringText(wb) {
    if (wb.needs && wb.wait) return "pluie attendue, patiente";
    if (wb.needs) return `à arroser, ${wb.litres} L`;
    if (wb.nextIn == null) return "pas d'arrosage avant 2 semaines";
    if (wb.nextIn === 1) return "arrosage demain";
    return `arrosage dans ${wb.nextIn} jours`;
  }

  const planCanvas = (forceShape) => `<div class="plan-wrap"><svg id="plan" role="application" aria-label="Plan 2D du jardin. Glisse les éléments pour les placer." data-shape="${forceShape ? 1 : 0}"></svg>
      <div class="north" aria-label="Nord"><span style="transform:rotate(${S.garden.north || 0}deg)">▲<br>N</span></div>
      <div class="scale" id="planScale"></div>
      <div class="plan-tools">
        <button type="button" data-act="zoomIn" aria-label="Zoomer">+</button>
        <button type="button" data-act="zoomOut" aria-label="Dézoomer">−</button>
        <button type="button" data-act="zoomFit" aria-label="Voir tout le terrain">⤢</button>
      </div></div>`;

  function bounds(pts) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }

  function fitView() {
    const b = bounds(S.garden.shape);
    const w = Math.max(1, b.maxX - b.minX), h = Math.max(1, b.maxY - b.minY), pad = Math.max(w, h) * 0.12 + 0.4;
    view = { x: (b.minX - pad) * 100, y: (b.minY - pad) * 100, w: (w + pad * 2) * 100, h: (h + pad * 2) * 100 };
  }

  // Le SVG est en centimètres pour éviter les tailles de police minuscules, mal gérées par Safari.
  function drawPlan() {
    const svg = $("plan");
    if (!svg) return;
    if (!view) fitView();
    const editing = svg.dataset.shape === "1";
    svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
    const rect = svg.getBoundingClientRect();
    const px = Math.max(view.w / Math.max(1, rect.width), view.h / Math.max(1, rect.height));
    const pts = S.garden.shape, today = todayISO();
    const polyStr = pts.map((p) => `${p[0] * 100},${p[1] * 100}`).join(" ");
    const b = bounds(pts);
    const gridStep = Math.max(b.maxX - b.minX, b.maxY - b.minY) > 40 ? 5 : 1;
    let grid = "";
    for (let x = Math.ceil(b.minX / gridStep) * gridStep; x <= b.maxX; x += gridStep) grid += `<line x1="${x * 100}" x2="${x * 100}" y1="${b.minY * 100}" y2="${b.maxY * 100}"/>`;
    for (let y = Math.ceil(b.minY / gridStep) * gridStep; y <= b.maxY; y += gridStep) grid += `<line y1="${y * 100}" y2="${y * 100}" x1="${b.minX * 100}" x2="${b.maxX * 100}"/>`;

    const sides = pts.map((p, i) => {
      const q = pts[(i + 1) % pts.length], len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len * 100 / px < 34) return "";
      return `<text x="${(p[0] + q[0]) * 50}" y="${(p[1] + q[1]) * 50}" text-anchor="middle" dominant-baseline="middle" font-size="${11 * px}" fill="#fff" stroke="rgba(8,25,15,.85)" stroke-width="${3.2 * px}" paint-order="stroke">${num(len)} m</text>`;
    }).join("");

    const zones = (S.garden.zones || []).map((z) => {
      const t = ZONES[z.type], on = selected && selected.kind === "z" && selected.id === z.id;
      const s = Math.min(z.w, z.h) * 100;
      return `<g data-zid="${z.id}"><rect x="${z.x * 100}" y="${z.y * 100}" width="${z.w * 100}" height="${z.h * 100}" rx="${8 * px}" fill="${t.c}" fill-opacity="${z.type === "serre" ? 0.22 : 0.45}" stroke="${on ? "#fff" : t.c}" stroke-width="${(on ? 2.5 : 1.2) * px}" ${z.type === "serre" ? `stroke-dasharray="${6 * px} ${4 * px}"` : ""}/>
        <text x="${(z.x + z.w / 2) * 100}" y="${(z.y + z.h / 2) * 100}" text-anchor="middle" dominant-baseline="central" font-size="${Math.min(s * 0.6, 26 * px)}">${t.e}</text></g>`;
    }).join("");

    const items = active().filter((p) => !E.isIndoors(p) && p.w).map((p) => plantingShape(p, px, today)).join("");
    const handle = (() => {
      const it = selectedItem();
      if (!it || !it.w) return "";
      return `<circle data-handle="1" cx="${(it.x + it.w) * 100}" cy="${(it.y + it.h) * 100}" r="${11 * px}" fill="#fff" stroke="#0b2316" stroke-width="${2 * px}"/>`;
    })();
    const verts = editing ? pts.map((p, i) => {
      const q = pts[(i + 1) % pts.length];
      return `<circle data-mid="${i}" cx="${(p[0] + q[0]) * 50}" cy="${(p[1] + q[1]) * 50}" r="${6 * px}" fill="#fff" fill-opacity=".55"/>
        <circle data-v="${i}" cx="${p[0] * 100}" cy="${p[1] * 100}" r="${11 * px}" fill="#fff" stroke="#0b2316" stroke-width="${2 * px}"/>`;
    }).join("") : "";

    // En dessinant, un côté passe au vert dès qu'il est parfaitement horizontal ou vertical.
    const straight = editing ? pts.map((p, i) => {
      const q = pts[(i + 1) % pts.length];
      if (p[0] !== q[0] && p[1] !== q[1]) return "";
      return `<line data-straight="1" x1="${p[0] * 100}" y1="${p[1] * 100}" x2="${q[0] * 100}" y2="${q[1] * 100}" stroke="var(--ok)" stroke-width="${4.5 * px}" stroke-linecap="round"/>`;
    }).join("") : "";

    svg.innerHTML = `<defs><clipPath id="terrain"><polygon points="${polyStr}"/></clipPath></defs>
      <polygon points="${polyStr}" fill="rgba(120,180,110,.22)"/>
      <g clip-path="url(#terrain)" stroke="rgba(255,255,255,.14)" stroke-width="${px}">${grid}</g>
      <polygon points="${polyStr}" fill="none" stroke="#fff" stroke-width="${2.2 * px}" stroke-linejoin="round"/>
      ${straight}${zones}${items}${sides}${handle}${verts}`;
    const sc = $("planScale");
    if (sc) sc.textContent = `Grille : ${gridStep} m`;
  }

  function plantingShape(p, px, today) {
    const plant = E.plantOf(p), on = selected && selected.kind === "p" && selected.id === p.id;
    const future = p.date > today;
    let fill = FAM[plant.f].c, thirsty = false;
    if (overlay === "eau" && ready()) {
      const wb = E.waterBalance(p, S.garden, S.weather, S.clim, today);
      if (wb) {
        thirsty = wb.needs && !wb.wait;
        fill = thirsty ? "var(--ko)" : wb.nextIn != null && wb.nextIn <= 2 ? "var(--warn)" : "var(--rain)";
      } else fill = "#9aa89f";
    } else if (overlay === "cultures") fill = "#9fe3a8";
    const X = p.x * 100, Y = p.y * 100, W = p.w * 100, H = p.h * 100;
    const cols = Math.max(1, Math.min(8, Math.floor(p.w / plant.esp + 1e-6)));
    const rows = Math.max(1, Math.min(8, Math.floor(p.h / plant.rang + 1e-6)));
    const fs = Math.max(13 * px, Math.min(Math.min(W / cols, H / rows) * 0.72, 44 * px));
    let emojis = "";
    const showAll = W / cols > 13 * px && H / rows > 13 * px;
    if (showAll) {
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) emojis += `<text x="${X + (c + 0.5) * W / cols}" y="${Y + (r + 0.5) * H / rows}" text-anchor="middle" dominant-baseline="central" font-size="${fs}">${plant.e}</text>`;
    } else emojis = `<text x="${X + W / 2}" y="${Y + H / 2}" text-anchor="middle" dominant-baseline="central" font-size="${Math.min(Math.min(W, H) * 0.7, 30 * px)}">${plant.e}</text>`;
    const label = W / px > 64 && H / px > 26 ? `<text x="${X + 5 * px}" y="${Y + 13 * px}" font-size="${11 * px}" font-weight="600" fill="#fff" stroke="rgba(8,25,15,.85)" stroke-width="${3 * px}" paint-order="stroke">${esc(plant.n)}${thirsty ? " 💧" : ""}</text>` : thirsty ? `<text x="${X + W - 2 * px}" y="${Y + 13 * px}" text-anchor="end" font-size="${13 * px}">💧</text>` : "";
    return `<g data-pid="${p.id}"><rect x="${X}" y="${Y}" width="${W}" height="${H}" rx="${8 * px}" fill="${fill}" fill-opacity="${future ? 0.14 : 0.32}" stroke="${on ? "#fff" : fill}" stroke-width="${(on ? 2.8 : 1.3) * px}"${future ? ` stroke-dasharray="${6 * px} ${4 * px}"` : ""}/>${emojis}${label}</g>`;
  }

  let gesture = null, longPress = null;
  const pointers = new Map();
  const snap = (v) => Math.round(v * 10) / 10;
  const MAGNET_PX = 10;

  function toPlan(e) {
    const svg = $("plan"), m = svg.getScreenCTM().inverse();
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
    return { x: pt.x / 100, y: pt.y / 100, cx: pt.x, cy: pt.y };
  }

  function initPlan() {
    const svg = $("plan");
    view = null;
    drawPlan();
    svg.addEventListener("pointerdown", onDown);
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerup", onUp);
    svg.addEventListener("pointercancel", onUp);
    svg.addEventListener("wheel", (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 0.85 : 1.18); }, { passive: false });
    svg.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  function onDown(e) {
    const svg = $("plan");
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    clearTimeout(longPress);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = { type: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y) };
      return;
    }
    const t = e.target, editing = svg.dataset.shape === "1", at = toPlan(e);
    const base = { start: at, moved: false, cx: e.clientX, cy: e.clientY };
    const vEl = editing && t.closest("[data-v]"), midEl = editing && t.closest("[data-mid]");
    if (vEl) {
      const i = +vEl.dataset.v;
      gesture = { ...base, type: "vertex", i, orig: [...S.garden.shape[i]] };
      if (S.garden.shape.length > 3) longPress = setTimeout(() => {
        if (gesture && gesture.type === "vertex" && !gesture.moved) { S.garden.shape.splice(i, 1); gesture = null; afterShapeEdit(); }
      }, 650);
      return;
    }
    if (midEl) {
      const i = +midEl.dataset.mid, shape = S.garden.shape, p = shape[i], q = shape[(i + 1) % shape.length];
      shape.splice(i + 1, 0, [snap((p[0] + q[0]) / 2), snap((p[1] + q[1]) / 2)]);
      S.garden.shapeKind = "free";
      gesture = { ...base, type: "vertex", i: i + 1, orig: [...shape[i + 1]], moved: true };
      drawPlan();
      return;
    }
    if (t.closest("[data-handle]") && selectedItem()) {
      const it = selectedItem();
      gesture = { ...base, type: "resize", item: it, orig: { w: it.w, h: it.h } };
      return;
    }
    const pEl = !editing && t.closest("[data-pid]"), zEl = !editing && t.closest("[data-zid]");
    if (pEl || zEl) {
      const sel = pEl ? { kind: "p", id: pEl.dataset.pid } : { kind: "z", id: zEl.dataset.zid };
      const item = pEl ? S.plantings.find((p) => p.id === sel.id) : S.garden.zones.find((z) => z.id === sel.id);
      gesture = { ...base, type: "drag", sel, item, orig: { x: item.x, y: item.y } };
      return;
    }
    gesture = { ...base, type: "pan", view: { ...view } };
  }

  function onMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture) return;
    if (gesture.type === "pinch") {
      if (pointers.size < 2) return;
      const [a, b] = [...pointers.values()], dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist > 0) { zoom(gesture.dist / dist); gesture.dist = dist; }
      return;
    }
    if (!gesture.moved && Math.hypot(e.clientX - gesture.cx, e.clientY - gesture.cy) < 5) return;
    gesture.moved = true;
    clearTimeout(longPress);
    if (gesture.type === "pan") {
      const svg = $("plan"), r = svg.getBoundingClientRect(), k = Math.max(view.w / r.width, view.h / r.height);
      view.x = gesture.view.x - (e.clientX - gesture.cx) * k;
      view.y = gesture.view.y - (e.clientY - gesture.cy) * k;
      drawPlan();
      return;
    }
    const at = toPlan(e), dx = at.x - gesture.start.x, dy = at.y - gesture.start.y;
    if (gesture.type === "drag") {
      selected = gesture.sel;
      const b = bounds(S.garden.shape), it = gesture.item;
      it.x = snap(E.clamp(gesture.orig.x + dx, b.minX, Math.max(b.minX, b.maxX - it.w)));
      it.y = snap(E.clamp(gesture.orig.y + dy, b.minY, Math.max(b.minY, b.maxY - it.h)));
    } else if (gesture.type === "resize") {
      const it = gesture.item;
      it.w = Math.max(0.2, snap(gesture.orig.w + dx));
      it.h = Math.max(0.2, snap(gesture.orig.h + dy));
    } else if (gesture.type === "vertex") {
      const svg = $("plan"), r = svg.getBoundingClientRect();
      const reach = Math.max(view.w / r.width, view.h / r.height) * MAGNET_PX / 100;
      S.garden.shape[gesture.i] = alignVertex(S.garden.shape, gesture.i, snap(gesture.orig[0] + dx), snap(gesture.orig[1] + dy), reach);
      S.garden.shapeKind = "free";
      updateAreaLabel();
    }
    drawPlan();
  }

  function onUp(e) {
    pointers.delete(e.pointerId);
    clearTimeout(longPress);
    if (!gesture) return;
    const g = gesture;
    if (g.type === "pinch") { if (pointers.size < 2) gesture = null; return; }
    gesture = null;
    if (!g.moved) {
      if (g.type === "drag") selected = g.sel;
      else if (g.type === "pan") selected = null;
      drawPlan(); refreshSel();
      return;
    }
    if (g.type === "resize" && selected && selected.kind === "p") {
      const plant = E.plantOf(g.item);
      g.item.count = E.capacity(plant, g.item.w, g.item.h);
    }
    if (g.type === "vertex") { afterShapeEdit(); return; }
    if (g.type !== "pan") { save(); drawPlan(); refreshSel(); }
  }

  // Aimante un angle sur ses deux voisins pour obtenir facilement des côtés bien droits.
  function alignVertex(shape, i, x, y, reach) {
    const n = shape.length, prev = shape[(i - 1 + n) % n], next = shape[(i + 1) % n];
    const near = (v, a, b) => {
      const da = Math.abs(v - a), db = Math.abs(v - b);
      return Math.min(da, db) > reach ? v : da <= db ? a : b;
    };
    const ax = near(x, prev[0], next[0]), ay = near(y, prev[1], next[1]);
    const merged = (ax === prev[0] && ay === prev[1]) || (ax === next[0] && ay === next[1]);
    return merged ? [x, y] : [ax, ay];
  }

  function afterShapeEdit() {
    save();
    if (!S.setupDone && !document.querySelector('[data-kind="free"][aria-pressed="true"]')) { render(); return; }
    drawPlan(); updateAreaLabel();
  }
  const updateAreaLabel = () => { const l = $("areaLabel"); if (l) l.textContent = `${num(E.polygonArea(S.garden.shape))} m²`; };
  function refreshSel() { const box = $("selPanel"); if (box) box.innerHTML = selPanel(selectedItem()); }

  function zoom(factor) {
    if (!view) return;
    const cx = view.x + view.w / 2, cy = view.y + view.h / 2, b = bounds(S.garden.shape);
    const maxW = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 300 + 400;
    const w = E.clamp(view.w * factor, 80, maxW), h = view.h * w / view.w;
    view = { x: cx - w / 2, y: cy - h / 2, w, h };
    drawPlan();
  }

  /* ---------- Onglet Cultures ---------- */

  function culturesView() {
    const today = todayISO(), list = active();
    const growing = list.filter((p) => p.date <= today), planned = list.filter((p) => p.date > today);
    const past = S.plantings.filter((p) => p.endDate && E.plantOf(p)).sort((a, b) => (a.endDate < b.endDate ? 1 : -1));
    const allH = S.plantings.flatMap((p) => (p.harvests || []).map((h) => ({ plant: p.plant, kg: h.kg })));
    const totalKg = allH.reduce((s, h) => s + h.kg, 0);
    const totalL = S.plantings.flatMap((p) => p.waterings || []).reduce((s, w) => s + w.l, 0);
    const byPlant = {};
    allH.forEach((h) => { byPlant[h.plant] = (byPlant[h.plant] || 0) + h.kg; });
    const top = Object.entries(byPlant).sort((a, b) => b[1] - a[1]);
    const maxKg = top.length ? top[0][1] : 1;
    return `<section class="glass panel"><h2>Tes cultures</h2>
        <div class="tiles" style="margin-top:0">
          <div class="tile"><b>${growing.length}</b><span>en place</span></div>
          <div class="tile"><b>${num(totalKg)} kg</b><span>récoltés</span></div>
          <div class="tile"><b>${num(totalL, 0)} L</b><span>arrosés</span></div>
        </div></section>
      <section class="glass panel">
        ${growing.length ? growing.map((p) => cultureRow(p, today)).join("") : '<p class="muted">Rien en terre pour l\'instant.</p>'}
        <button class="primary wide" style="margin-top:10px" type="button" data-act="goPlanter">+ Planter</button>
      </section>
      ${planned.length ? `<section class="glass panel"><h2>Prévues</h2>${planned.map((p) => cultureRow(p, today)).join("")}</section>` : ""}
      ${top.length ? `<section class="glass panel stack"><h2>Récoltes par plante</h2>${top.map(([k, kg]) => `<div><div class="row between"><span>${PLANTS[k].e} ${esc(PLANTS[k].n)}</span><b>${num(kg)} kg</b></div><div class="gauge"><i style="width:${Math.max(4, kg / maxKg * 100)}%;background:var(--ok)"></i></div></div>`).join("")}</section>` : ""}
      ${past.length ? `<section class="glass panel"><h2>Historique</h2><p class="muted small" style="margin-bottom:6px">Utilisé pour vérifier la rotation des cultures.</p>${past.map((p) => cultureRow(p, today, true)).join("")}</section>` : ""}`;
  }

  function cultureRow(p, today, ended) {
    const plant = E.plantOf(p);
    const wb = !ended && ready() ? E.waterBalance(p, S.garden, S.weather, S.clim, today) : null;
    const est = !ended && ready() ? E.harvestEstimate(p, S.weather, S.clim) : null;
    const sub = ended ? `${shortDate(p.date)} au ${shortDate(p.endDate)}`
      : E.isIndoors(p) ? `Semé à l'abri le ${shortDate(p.date)}`
      : p.date > today ? `Prévu le ${shortDate(p.date)}`
      : [wb && wb.stage, wb && wateringText(wb)].filter(Boolean).join(", ");
    const pct = wb ? Math.round(wb.reserve * 100) : null;
    const cls = wb && wb.needs ? "dry" : wb && wb.nextIn != null && wb.nextIn <= 2 ? "low" : "";
    const harvest = est && est.late ? `<div class="hint">Plantée trop tard : le gel arrivera avant la récolte, vers le ${shortDate(est.limit)}</div>` : est && plant.rdt > 0 && !plant.vivace && p.date <= today ? `<div class="hint">Récolte estimée : ${shortDate(est.from)} au ${shortDate(est.to)}</div>` : "";
    return `<button class="culture" type="button" data-act="openCulture" data-id="${p.id}">
        <span class="emo" aria-hidden="true">${plant.e}</span>
        <span class="grow"><b>${esc(plant.n)}${p.variety ? " " + esc(p.variety) : ""}</b>
          <div class="muted small">${esc(sub)}</div>${harvest}
          ${wb ? `<div class="gauge" role="img" aria-label="Réserve d'eau ${pct} %"><i class="${cls}" style="width:${Math.max(3, pct)}%"></i></div>` : ""}</span>
      </button>`;
  }

  function cultureSheet(id) {
    const p = S.plantings.find((x) => x.id === id);
    if (!p) return;
    const plant = E.plantOf(p), today = todayISO();
    const wb = ready() ? E.waterBalance(p, S.garden, S.weather, S.clim, today) : null;
    const est = ready() ? E.harvestEstimate(p, S.weather, S.clim) : null;
    const place = p.w ? { id: p.id, x: p.x, y: p.y, w: p.w, h: p.h, sun: p.sun } : null;
    const checks = ready() && place && !p.endDate ? E.canPlant({ plantKey: p.plant, method: p.method, date: p.date, garden: S.garden, weather: [], clim: S.clim, plantings: S.plantings, place, covered: E.isCovered(p, S.garden) }).checks.filter((c) => /Voisin|voisinage|Rotation|Déborde/.test(c.title)) : [];
    const waters = [...(p.waterings || [])].reverse().slice(0, 5);
    const harvests = [...(p.harvests || [])].reverse();
    const open = !p.endDate;
    sheet.innerHTML = `<div class="sheet">
      <div class="sheet-head"><h2>${plant.e} ${esc(plant.n)}</h2><button class="close" type="button" data-act="closeSheet" aria-label="Fermer">✕</button></div>
      ${wb ? `<div class="stack">
          <div class="tiles" style="margin-top:0">
            <div class="tile"><b>${Math.round(wb.reserve * 100)} %</b><span>réserve d'eau</span></div>
            <div class="tile"><b>${wb.needs ? wb.litres + " L" : wb.nextIn == null ? "14 j +" : wb.nextIn + " j"}</b><span>${wb.needs ? "à donner" : "avant arrosage"}</span></div>
            <div class="tile"><b style="font-size:13px;line-height:1.6;overflow-wrap:normal">${esc(wb.stage)}</b><span>stade</span></div>
          </div>
          ${reserveChart(wb, today)}
          <p class="muted small">Calcul : ${num(wb.today.et)} mm consommés aujourd'hui, racines à ${Math.round(wb.today.taw / E.soilReserve(S.garden.soil).taw * 100)} cm, réserve totale ${num(wb.today.taw, 0)} mm${wb.covered ? ", sous abri : la pluie ne compte pas" : ""}.</p>
        </div>` : ""}
      ${est && est.late ? `<p>🥶 Plantée trop tard : le gel arrivera avant la récolte, vers le <b>${shortDate(est.limit)}</b>.</p>` : est && plant.rdt > 0 ? `<p>🧺 Récolte estimée du <b>${shortDate(est.from)}</b> au <b>${shortDate(est.to)}</b>${E.yearOf(est.from) !== E.yearOf(today) ? ` ${E.yearOf(est.from)}` : ""}.</p>` : ""}
      ${checks.length ? `<ul class="checks">${checks.map(checkLI).join("")}</ul>` : ""}
      ${E.isIndoors(p) && open ? '<button class="primary" type="button" data-act="transplant" data-id="' + p.id + '">🌱 C\'est repiqué en terre</button>' : ""}
      ${open && !E.isIndoors(p) && p.date <= today ? `<div class="stack"><div class="field"><label for="waterL">Arrosage d'aujourd'hui (litres)</label>
          <div class="row"><input id="waterL" class="grow" style="width:auto" type="number" inputmode="decimal" min="0.5" step="0.5" value="${wb && wb.litres > 0 ? wb.litres : 5}"><button class="primary" type="button" data-act="waterCustom" data-id="${p.id}">💧 Noter</button></div></div>
          ${waters.length ? `<p class="hint">Derniers arrosages : ${waters.map((w) => `${shortDate(w.date)} (${num(w.l)} L)`).join(", ")}</p>` : ""}</div>
        <div class="stack"><div class="field"><label for="harvestKg">Récolte (kg)</label>
          <div class="row"><input id="harvestKg" class="grow" style="width:auto" type="number" inputmode="decimal" min="0.01" step="0.1" placeholder="0,5"><button class="soft" type="button" data-act="harvest" data-id="${p.id}">🧺 Noter</button></div></div>
          ${harvests.length ? `<p class="hint">Récoltes : ${harvests.slice(0, 5).map((h) => `${shortDate(h.date)} (${num(h.kg)} kg)`).join(", ")}</p>` : ""}</div>` : ""}
      <details><summary>Réglages de cette culture</summary><div class="stack" style="margin-top:10px">
        <div class="two">
          <div class="field"><label for="c-var">Variété</label><input id="c-var" data-cset="variety" value="${esc(p.variety || "")}" placeholder="Cœur de bœuf"></div>
          <div class="field full"><label for="c-date">Date</label><input id="c-date" type="date" data-cset="date" value="${p.date}"></div>
          <div class="field"><label for="c-count">Nombre de plants</label><input id="c-count" type="number" inputmode="numeric" min="1" data-cset="count" data-type="num" value="${p.count}"></div>
          <div class="field"><label for="c-irr">Arrosage</label><select id="c-irr" data-cset="irrigation">${opts(E.IRRIG, p.irrigation)}</select></div>
          <div class="field"><label for="c-sun">Soleil ici</label><select id="c-sun" data-cset="sun">${opts(E.SUN, p.sun || S.garden.sun)}</select></div>
          <div class="field"><label for="c-size">Taille (m)</label><div class="row" style="flex-wrap:nowrap"><input id="c-size" type="number" inputmode="decimal" min="0.2" step="0.1" data-cset="w" data-type="num" aria-label="Largeur" value="${p.w ?? ""}"><input type="number" inputmode="decimal" min="0.2" step="0.1" data-cset="h" data-type="num" aria-label="Longueur" value="${p.h ?? ""}"></div></div>
        </div>
        <label class="check"><input type="checkbox" data-cset="mulch" data-type="bool"${p.mulch ? " checked" : ""}> Sol paillé</label>
        <label class="check"><input type="checkbox" data-cset="covered" data-type="bool"${p.covered ? " checked" : ""}> Sous serre ou tunnel</label>
        <div class="field"><label for="c-notes">Notes</label><textarea id="c-notes" data-cset="notes">${esc(p.notes || "")}</textarea></div>
      </div></details>
      <div class="row">
        ${open ? `<button class="soft grow" type="button" data-act="endCulture" data-id="${p.id}">Clôturer la culture</button>` : ""}
        <button class="soft grow danger" type="button" data-act="deleteCulture" data-id="${p.id}">Supprimer</button>
      </div></div>`;
    sheet.dataset.culture = id;
    openSheet();
  }

  function reserveChart(wb, today) {
    const rows = wb.series.slice(-30);
    if (rows.length < 3) return "";
    const W = 600, H = 96, x = (i) => i / (rows.length - 1) * W;
    const y = (r) => 8 + (1 - E.clamp(1 - r.dr / r.taw, 0, 1)) * (H - 16);
    const line = rows.map((r, i) => `${x(i).toFixed(1)},${y(r).toFixed(1)}`).join(" ");
    const seuil = rows.map((r, i) => `${x(i).toFixed(1)},${(8 + r.raw / r.taw * (H - 16)).toFixed(1)}`).join(" ");
    const ti = rows.findIndex((r) => r.d === today);
    return `<div><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Réserve d'eau du sol, passé et prévision">
        <polyline points="${seuil}" fill="none" stroke="var(--warn)" stroke-width="1.5" stroke-dasharray="5 5"/>
        <polyline points="${line}" fill="none" stroke="var(--rain)" stroke-width="2.5" stroke-linejoin="round"/>
        ${ti >= 0 ? `<line x1="${x(ti)}" x2="${x(ti)}" y1="2" y2="${H - 2}" stroke="var(--ink-2)" stroke-dasharray="3 4"/><circle cx="${x(ti)}" cy="${y(rows[ti])}" r="5" fill="var(--rain)" stroke="#0e2619" stroke-width="2"/>` : ""}
      </svg><div class="legend"><span><i style="background:var(--rain)"></i>Réserve d'eau du sol</span><span><i style="background:var(--warn)"></i>Seuil d'arrosage</span><span class="muted">Trait pointillé vertical : aujourd'hui</span></div></div>`;
  }

  const checkLI = (c) => {
    const sign = { ok: "✓", warn: "!", block: "✕", info: "i" }[c.level];
    return `<li><span class="mark ${c.level}" aria-hidden="true">${sign}</span><div class="grow"><b>${esc(c.title)}</b><div class="muted small">${esc(c.detail)}</div></div></li>`;
  };

  /* ---------- Onglet Planter ---------- */

  function planterView() {
    if (!ready()) return waiting();
    return `<section class="glass panel stack">
        <h2 style="margin:0">Puis-je planter ?</h2>
        <div class="field"><label for="plantSearch">Cherche une plante</label><input id="plantSearch" type="search" autocomplete="off" placeholder="Tomate, ail, fraisier…" value="${esc(filter.q)}"></div>
        <div class="chips" role="group" aria-label="Catégories">
          ${[["maintenant", "Possible maintenant"], ["tout", "Toutes"], ...Object.entries(CATS)].map(([k, t]) => `<button class="chip" type="button" data-act="cat" data-v="${k}" aria-pressed="${filter.cat === k}">${esc(t)}</button>`).join("")}
        </div>
        <div id="plantGrid" class="plants">${plantGrid()}</div>
      </section>`;
  }

  function nowMap() {
    const today = todayISO();
    if (!nowCache || nowCache.today !== today) {
      const map = {};
      for (const key of Object.keys(PLANTS)) map[key] = E.bestMethod({ plantKey: key, date: today, garden: S.garden, weather: S.weather, clim: S.clim, plantings: S.plantings });
      nowCache = { today, map };
    }
    return nowCache.map;
  }

  function plantGrid() {
    const map = nowMap(), q = norm(filter.q);
    const rank = { oui: 0, prudence: 1, non: 2 };
    const keys = Object.keys(PLANTS)
      .filter((k) => !q || norm(PLANTS[k].n).includes(q))
      .filter((k) => filter.cat === "tout" || (filter.cat === "maintenant" ? map[k].verdict !== "non" : PLANTS[k].cat === filter.cat))
      .sort((a, b) => rank[map[a].verdict] - rank[map[b].verdict] || PLANTS[a].n.localeCompare(PLANTS[b].n, "fr"));
    if (!keys.length) return `<p class="muted" style="grid-column:1/-1">${filter.cat === "maintenant" ? "Rien à lancer en ce moment : essaie « Toutes » pour voir les prochaines dates." : "Pas de plante à ce nom pour l'instant."}</p>`;
    const label = { oui: "Oui", prudence: "Prudence", non: "Pas encore" };
    return keys.map((k) => `<button class="plant-tile" type="button" data-act="advise" data-k="${k}"><span class="emo" aria-hidden="true">${PLANTS[k].e}</span><span class="nm">${esc(PLANTS[k].n)}</span><span class="tag ${map[k].verdict}">${label[map[k].verdict]}</span></button>`).join("");
  }

  function openAdvisor(key) {
    const today = todayISO();
    const best = E.bestMethod({ plantKey: key, date: today, garden: S.garden, weather: S.weather, clim: S.clim, plantings: S.plantings });
    advisor = { key, method: best.method, date: today, count: PLANTS[key].arbre ? 1 : 3, covered: false, variety: "" };
    renderAdvisor();
    openSheet();
  }

  function renderAdvisor() {
    const a = advisor, plant = PLANTS[a.key], today = todayISO();
    const res = E.canPlant({ plantKey: a.key, method: a.method, date: a.date, garden: S.garden, weather: S.weather, clim: S.clim, plantings: S.plantings, covered: a.covered });
    const head = { oui: "Oui, vas-y", prudence: "Oui, avec précautions", non: "Pas maintenant" }[res.verdict];
    const others = Object.keys(plant.win || {}).map((m) => {
      const wins = E.windowsFor(plant, m, S.clim, E.yearOf(a.date), S.garden, a.covered);
      const cur = E.inWindow(wins, a.date), nxt = E.nextWindow(wins, a.date);
      return `<li>${esc(E.METHODS[m])} : ${cur ? `<b>possible jusqu'au ${esc(E.fmt(cur.to))}</b>` : nxt ? `à partir du ${esc(E.fmt(nxt.from))}` : "—"}</li>`;
    }).join("");
    const cal = E.yearCalendar(plant, S.clim, S.garden, E.yearOf(today));
    const nowMonth = new Date().getMonth();
    const calRows = Object.keys(cal).map((m) => `<div>${{ semis: "Pleine terre", abri: "À l'abri", plant: "Plants" }[m]}</div>${cal[m].map((on, i) => `<div class="c${on ? " on" : ""}${i === nowMonth ? " now" : ""}" title="${MONTH_NAMES[i]}"></div>`).join("")}`).join("");
    const size = E.suggestSize(plant, a.count);
    const friends = (plant.amis || []).map((k) => PLANTS[k] && PLANTS[k].n).filter(Boolean).join(", ");
    const foes = (plant.ennemis || []).map((k) => PLANTS[k] && PLANTS[k].n).filter(Boolean).join(", ");
    const waterNeed = plant.kc[1] >= 1.1 ? "Élevé" : plant.kc[1] >= 0.9 ? "Moyen" : "Faible";
    sheet.dataset.culture = "";
    sheet.innerHTML = `<div class="sheet">
      <div class="sheet-head"><h2>${plant.e} ${esc(plant.n)}</h2><button class="close" type="button" data-act="closeSheet" aria-label="Fermer">✕</button></div>
      <div class="field"><label for="a-date">Date</label><input id="a-date" type="date" data-aset="date" value="${a.date}"></div>
      <div class="field"><label for="a-count">Nombre de plants</label><input id="a-count" type="number" inputmode="numeric" min="1" data-aset="count" data-type="num" value="${a.count}"></div>
      <div class="chips" role="group" aria-label="Méthode">${Object.keys(plant.win || {}).map((m) => `<button class="chip" type="button" data-act="advMethod" data-v="${m}" aria-pressed="${a.method === m}">${esc(E.METHODS[m])}</button>`).join("")}</div>
      ${a.method !== "abri" ? `<label class="check"><input type="checkbox" data-aset="covered" data-type="bool"${a.covered ? " checked" : ""}> Sous serre ou tunnel</label>` : ""}
      <div class="verdict ${res.verdict}" role="status"><h3>${head}</h3><ul class="small" style="margin:6px 0 0;padding-left:18px">${others}</ul></div>
      <ul class="checks">${res.checks.map(checkLI).join("")}</ul>
      ${plant.note ? `<p class="muted small">💡 ${esc(plant.note)}</p>` : ""}
      <button class="primary" type="button" data-act="addPlanting">${res.verdict === "non" ? (a.date > today ? "Prévoir quand même" : "Ajouter quand même") : a.date > today ? "Prévoir au jardin" : "Ajouter au jardin"}</button>
      <div class="hint">Place conseillée : ${num(size.w)} × ${num(size.h)} m, à ajuster sur le plan.</div>
      <h3>Calendrier pour ton jardin</h3>
      <div class="cal"><div></div>${MONTHS.map((m) => `<div class="m">${m}</div>`).join("")}${calRows}</div>
      <div class="tiles" style="margin-top:0">
        <div class="tile"><b>${Math.round(plant.esp * 100)} × ${Math.round(plant.rang * 100)}</b><span>cm entre plants et rangs</span></div>
        <div class="tile"><b>${waterNeed}</b><span>besoin en eau</span></div>
        <div class="tile"><b>${plant.tmin} °C</b><span>tient jusqu'à</span></div>
      </div>
      ${friends ? `<p class="small"><b>Bons voisins :</b> <span class="muted">${esc(friends)}</span></p>` : ""}
      ${foes ? `<p class="small"><b>À éloigner :</b> <span class="muted">${esc(foes)}</span></p>` : ""}
      ${friends || foes ? '<p class="hint">Associations traditionnelles du jardinage, à prendre comme des repères.</p>' : ""}
      </div>`;
  }

  function addPlanting() {
    const a = advisor, plant = PLANTS[a.key];
    const count = Math.max(1, a.count || 1);
    const size = E.suggestSize(plant, count);
    const indoors = a.method === "abri";
    const spot = indoors ? null : E.findFreeSpot(S.garden, S.plantings, size.w, size.h);
    const p = {
      id: uid(), plant: a.key, variety: a.variety || "", method: a.method, date: a.date, count,
      x: spot ? spot.x : indoors ? null : bounds(S.garden.shape).minX, y: spot ? spot.y : indoors ? null : bounds(S.garden.shape).minY,
      w: indoors ? null : size.w, h: indoors ? null : size.h,
      mulch: false, covered: a.covered, sun: null, irrigation: "arrosoir", waterings: [], harvests: [], notes: "",
    };
    S.plantings.push(p);
    save(); closeSheet();
    if (indoors) { toast(`${plant.n} ajouté : l'app te préviendra pour le repiquage.`); tab = "cultures"; }
    else {
      if (!spot) toast("Pas de place libre à cette taille : déplace-la sur le plan.", true);
      else toast(`${plant.n} placé sur le plan : glisse pour l'ajuster.`);
      selected = { kind: "p", id: p.id }; tab = "plan";
    }
    render();
  }

  /* ---------- Onglet Jardin ---------- */

  function jardinView() {
    const g = S.garden, c = S.clim, year = new Date().getFullYear();
    const f = c ? E.frostDates(c, year, g, false) : null;
    const rainY = c ? c.months.reduce((s, m) => s + m.rain, 0) : 0, etY = c ? c.months.reduce((s, m) => s + m.et0, 0) : 0;
    const area = E.polygonArea(g.shape);
    const used = active().filter((p) => p.w && !E.isIndoors(p)).reduce((s, p) => s + E.areaOf(p), 0);
    return `<section class="glass panel stack"><h2 style="margin:0">Identité</h2>
        <div class="field"><label for="g-name">Nom du jardin</label><input id="g-name" data-set="name" data-header="1" value="${esc(g.name)}"></div>
        <div class="row between"><div class="grow"><b>📍 ${esc(g.place || "Lieu inconnu")}</b><div class="muted small">${g.lat != null ? `${g.lat.toFixed(3)}, ${g.lon.toFixed(3)}` : ""}${g.elevation != null ? `, ${Math.round(g.elevation)} m d'altitude` : ""}</div></div>
          <button class="soft" type="button" data-act="changePlace">Changer</button></div>
        <div class="tiles" style="margin-top:0">
          <div class="tile"><b>${num(area)} m²</b><span>surface</span></div>
          <div class="tile"><b>${num(used)} m²</b><span>cultivés</span></div>
          <div class="tile"><b>${Math.round(used / Math.max(area, 0.01) * 100)} %</b><span>occupé</span></div>
        </div></section>
      ${c ? `<section class="glass panel stack"><h2 style="margin:0">Climat de ton coin</h2>
        <p class="muted small">Calculé sur ${c.years} ans de relevés à cet endroit.</p>
        <div class="tiles" style="margin-top:0">
          <div class="tile"><b>${c.frostFree ? "Rare" : shortDate(f.lf)}</b><span>dernier gel, 8 ans sur 10</span></div>
          <div class="tile"><b>${c.frostFree ? "Rare" : shortDate(f.ff)}</b><span>premier gel, 8 ans sur 10</span></div>
          <div class="tile"><b>${E.seasonLength(c, g)} j</b><span>saison sans gel</span></div>
          <div class="tile"><b>${num(c.extreme, 0)} °C</b><span>froid moyen de l'hiver</span></div>
          <div class="tile"><b>${E.hardinessZone(c.extreme) || "—"}</b><span>zone de rusticité</span></div>
          <div class="tile"><b>${rainY - etY > 0 ? "+" : ""}${num(rainY - etY, 0)} mm</b><span>pluie moins évaporation, par an</span></div>
        </div>
        <table><thead><tr><th scope="col">Mois</th><th scope="col">Min</th><th scope="col">Max</th><th scope="col">Pluie</th><th scope="col">Évap.</th></tr></thead>
          <tbody>${c.months.map((m, i) => `<tr><td>${MONTH_SHORT[i]}</td><td>${Math.round(m.tmin)}°</td><td>${Math.round(m.tmax)}°</td><td>${m.rain} mm</td><td>${m.et0} mm</td></tr>`).join("")}</tbody></table>
      </section>` : ""}
      <section class="glass panel stack">${soilForm()}</section>
      <section class="glass panel stack">${siteForm()}</section>
      <section class="glass panel stack"><h2 style="margin:0">Sauvegarde</h2>
        <p class="muted small">Tes données restent sur ce téléphone. Exporte-les de temps en temps : si tu désinstalles l'app ou changes de téléphone, ce fichier te permet de tout retrouver.</p>
        <div class="row"><button class="soft grow" type="button" data-act="exportData">Exporter</button><button class="soft grow" type="button" data-act="importData">Importer</button></div>
        <button class="ghost danger" style="justify-self:start" type="button" data-act="resetAll">Tout effacer et recommencer</button>
      </section>
      <p class="hint" style="padding:0 6px">Météo : Open-Meteo. Sol : SoilGrids (ISRIC). Eau : méthode FAO-56. Les conseils restent des estimations : ton œil et tes doigts dans la terre ont le dernier mot.</p>`;
  }

  /* ---------- Feuilles ---------- */

  function openSheet() { if (!sheet.open) sheet.showModal(); sheet.scrollTop = 0; }
  function closeSheet() { if (sheet.open) sheet.close(); advisor = null; sheet.dataset.culture = ""; }

  function placeSheet() {
    sheet.dataset.culture = "";
    sheet.innerHTML = `<div class="sheet"><div class="sheet-head"><h2>Changer de lieu</h2><button class="close" type="button" data-act="closeSheet" aria-label="Fermer">✕</button></div>
      <p class="muted small">La météo et le climat seront recalculés.</p>
      <button class="primary" type="button" data-act="geolocate">📍 Utiliser ma position</button>
      <div class="field"><label for="placeSearch">Ou cherche ta commune</label><input id="placeSearch" type="search" autocomplete="off" placeholder="Lille, Annecy, Brest…"></div>
      <div id="placeResults" class="results"></div></div>`;
    openSheet();
  }

  function zoneSheet() {
    sheet.dataset.culture = "";
    sheet.innerHTML = `<div class="sheet"><div class="sheet-head"><h2>Ajouter un élément</h2><button class="close" type="button" data-act="closeSheet" aria-label="Fermer">✕</button></div>
      <p class="muted small">Une culture posée dans une serre est automatiquement considérée sous abri.</p>
      <div class="plants">${Object.entries(ZONES).map(([k, z]) => `<button class="plant-tile" type="button" data-act="addZoneType" data-k="${k}"><span class="emo" aria-hidden="true">${z.e}</span><span class="nm">${esc(z.n)}</span></button>`).join("")}</div></div>`;
    openSheet();
  }

  /* ---------- Actions ---------- */

  const logWater = (id, litres) => {
    const p = S.plantings.find((x) => x.id === id);
    if (!p || !(litres > 0)) return;
    p.waterings = p.waterings || [];
    p.waterings.push({ date: todayISO(), l: litres });
    save();
  };

  function wateredMessage(id, litres) {
    const p = S.plantings.find((x) => x.id === id);
    const wb = ready() && p ? E.waterBalance(p, S.garden, S.weather, S.clim, todayISO()) : null;
    const reserve = wb ? ` Réserve du sol : ${Math.round(wb.reserve * 100)} %.` : "";
    return `💧 ${num(litres)} L ${litres >= 2 ? "notés" : "noté"} pour ${p ? E.plantOf(p).n.toLowerCase() : "cette culture"}.${reserve}`;
  }

  const actions = {
    refresh: () => refreshWeather(true),
    setupBack: () => { setupStep--; setupError = ""; view = null; render(); },
    setupNext: () => {
      if (setupStep < 3) { setupStep++; setupError = ""; view = null; render(); return; }
      S.setupDone = true; tab = "jour"; save(); render(); refreshWeather(true);
    },
    geolocate,
    pickPlace: (d) => {
      const r = placeResults[+d.i];
      if (r) setPlace(+r.latitude.toFixed(4), +r.longitude.toFixed(4), [r.name, r.admin1].filter(Boolean).join(", "), r.elevation);
    },
    changePlace: placeSheet,
    soilAuto: async () => {
      const msg = $("soilAutoMsg");
      if (S.garden.lat == null) { if (msg) msg.textContent = "Indique d'abord où est ton jardin."; return; }
      if (msg) msg.textContent = "Lecture des cartes de sol…";
      try {
        const a = await fetchSoil(), s = S.garden.soil;
        S.garden.soilAuto = a;
        s.texture = E.textureFromFractions(a.clay, a.sand);
        if (s.ph == null && a.ph) s.ph = +a.ph.toFixed(1);
        if (a.soc != null) s.humus = a.soc < 10 ? "faible" : a.soc > 25 ? "riche" : "moyen";
        save(); render();
      } catch (e) {
        const text = e.message === "vide" ? "Pas de données de sol autour de ton jardin. Choisis avec le test du boudin." : "Cartes de sol injoignables pour le moment. Réessaie plus tard, ou choisis avec le test du boudin.";
        const box = $("soilAutoMsg");
        if (box) box.textContent = text;
      }
    },
    shapeKind: (d) => {
      const g = S.garden;
      g.shapeKind = d.kind;
      if (d.kind === "rect") g.shape = rectShape(g.dims.w, g.dims.h);
      if (d.kind === "l") g.shape = lShape(g.dims);
      save(); view = null; render();
    },
    scaleArea: () => {
      const cur = E.polygonArea(S.garden.shape);
      const v = parseFloat(String(prompt("Surface exacte de ton terrain, en m² :", cur.toFixed(1))).replace(",", "."));
      if (!(v > 0)) return;
      const k = Math.sqrt(v / cur);
      S.garden.shape = S.garden.shape.map(([x, y]) => [+(x * k).toFixed(2), +(y * k).toFixed(2)]);
      if (S.garden.shapeKind !== "free") { S.garden.dims.w = +(S.garden.dims.w * k).toFixed(2); S.garden.dims.h = +(S.garden.dims.h * k).toFixed(2); S.garden.dims.cutW = +(S.garden.dims.cutW * k).toFixed(2); S.garden.dims.cutH = +(S.garden.dims.cutH * k).toFixed(2); }
      save(); view = null; render();
    },
    overlay: (d) => { overlay = d.v; render(); },
    zoomIn: () => zoom(0.8),
    zoomOut: () => zoom(1.25),
    zoomFit: () => { fitView(); drawPlan(); },
    toggleShape: () => { shapeMode = !shapeMode; selected = null; if (shapeMode) S.garden.shapeKind = "free"; save(); render(); },
    goPlanter: () => { tab = "planter"; render(); },
    addZone: zoneSheet,
    addZoneType: (d) => {
      const size = { allee: [1, 4], terrasse: [3, 3], cabane: [2, 2], serre: [3, 2], bassin: [2, 2], compost: [1, 1], arbre: [3, 3] }[d.k];
      const b = bounds(S.garden.shape);
      const spot = E.findFreeSpot(S.garden, S.plantings, size[0], size[1]) || { x: b.minX, y: b.minY };
      const z = { id: uid(), type: d.k, x: spot.x, y: spot.y, w: size[0], h: size[1] };
      S.garden.zones = [...(S.garden.zones || []), z];
      selected = { kind: "z", id: z.id };
      save(); closeSheet(); render();
    },
    removeZone: (d) => { S.garden.zones = S.garden.zones.filter((z) => z.id !== d.id); selected = null; save(); render(); },
    openCulture: (d) => cultureSheet(d.id),
    waterDone: (d) => { logWater(d.id, +d.l); toast(wateredMessage(d.id, +d.l)); render(); },
    waterCustom: (d) => {
      const v = parseFloat(String($("waterL").value).replace(",", "."));
      if (!(v > 0)) return toast("Indique un nombre de litres.", true);
      logWater(d.id, v); cultureSheet(d.id); render(); toast(wateredMessage(d.id, v));
    },
    harvest: (d) => {
      const v = parseFloat($("harvestKg").value), p = S.plantings.find((x) => x.id === d.id);
      if (!(v > 0) || !p) return toast("Indique un poids en kilos.", true);
      p.harvests = p.harvests || [];
      p.harvests.push({ date: todayISO(), kg: v });
      save(); cultureSheet(d.id); render(); toast(`🧺 ${num(v)} kg de ${E.plantOf(p).n.toLowerCase()} notés, bravo !`);
    },
    transplant: (d) => {
      const p = S.plantings.find((x) => x.id === d.id), plant = E.plantOf(p);
      const size = E.suggestSize(plant, p.count), b = bounds(S.garden.shape);
      const spot = E.findFreeSpot(S.garden, S.plantings, size.w, size.h) || { x: b.minX, y: b.minY };
      Object.assign(p, { method: "plant", date: todayISO(), x: spot.x, y: spot.y, w: size.w, h: size.h });
      selected = { kind: "p", id: p.id };
      save(); closeSheet(); tab = "plan"; render();
    },
    endCulture: (d) => {
      const p = S.plantings.find((x) => x.id === d.id);
      if (!p) return;
      p.endDate = todayISO();
      if (selected && selected.id === p.id) selected = null;
      save(); closeSheet(); toast("Culture clôturée : elle reste dans l'historique pour la rotation."); render();
    },
    deleteCulture: (d) => {
      if (!confirm("Supprimer cette culture et son historique ?")) return;
      S.plantings = S.plantings.filter((x) => x.id !== d.id);
      if (selected && selected.id === d.id) selected = null;
      save(); closeSheet(); render();
    },
    cat: (d) => { filter.cat = d.v; render(); },
    advise: (d) => openAdvisor(d.k),
    advMethod: (d) => { advisor.method = d.v; renderAdvisor(); },
    addPlanting,
    closeSheet: () => { closeSheet(); },
    exportData: () => {
      const out = { ...S, weather: undefined, current: undefined, exportedAt: new Date().toISOString() };
      const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url; a.download = `jardin-${todayISO()}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    },
    importData: () => $("importFile").click(),
    resetAll: () => {
      if (!confirm("Tout effacer : terrain, cultures et historique ? Cette action est définitive.")) return;
      S = emptyState(); setupStep = 0; selected = null; save(); render();
    },
  };

  document.addEventListener("click", (e) => {
    const nav = e.target.closest("#tabs button");
    if (nav) {
      tab = nav.dataset.tab; shapeMode = false;
      history.replaceState(null, "", "#" + tab);
      render(); window.scrollTo(0, 0);
      return;
    }
    const el = e.target.closest("[data-act]");
    if (el && actions[el.dataset.act]) actions[el.dataset.act](el.dataset);
  });
  sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); });

  const readValue = (el) => {
    const t = el.dataset.type;
    if (t === "bool") return el.checked;
    if (t === "num" || t === "cm") {
      if (el.value === "") return null;
      const v = parseFloat(el.value);
      if (Number.isNaN(v)) return null;
      return t === "cm" ? v / 100 : v;
    }
    return el.value;
  };

  document.addEventListener("input", (e) => {
    const el = e.target;
    if (el.id === "placeSearch") return searchPlace(el.value);
    if (el.id === "plantSearch") { filter.q = el.value; if (filter.q && filter.cat === "maintenant") filter.cat = "tout"; $("plantGrid").innerHTML = plantGrid(); return; }
    if (el.dataset.dim) {
      const v = parseFloat(el.value);
      if (!(v > 0)) return;
      const g = S.garden;
      g.dims[el.dataset.dim] = v;
      if (g.shapeKind === "l") { g.dims.cutW = Math.min(g.dims.cutW, g.dims.w - 0.5); g.dims.cutH = Math.min(g.dims.cutH, g.dims.h - 0.5); g.shape = lShape(g.dims); }
      else g.shape = rectShape(g.dims.w, g.dims.h);
      save(); view = null; fitView(); drawPlan(); updateAreaLabel();
    }
  });

  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset.set) {
      const path = el.dataset.set.split("."), v = readValue(el);
      let obj = S.garden;
      for (const k of path.slice(0, -1)) obj = obj[k];
      if (path.at(-1) === "stones" && v == null) return;
      if (path.at(-1) === "depth" && !(v > 0)) return;
      obj[path.at(-1)] = v;
      save();
      if (el.dataset.header) renderHeader();
      if (el.dataset.reset && S.setupDone) render();
      return;
    }
    if (el.dataset.cset && sheet.dataset.culture) {
      const p = S.plantings.find((x) => x.id === sheet.dataset.culture), key = el.dataset.cset, v = readValue(el);
      if (!p) return;
      if (["count", "w", "h"].includes(key) && !(v > 0)) return;
      if (key === "date" && !v) return;
      p[key] = v;
      save(); render();
      return;
    }
    if (el.dataset.aset && advisor) {
      const v = readValue(el);
      if (el.dataset.aset === "date" && !v) return;
      advisor[el.dataset.aset] = el.dataset.aset === "count" ? Math.max(1, v || 1) : v;
      renderAdvisor();
    }
  });

  $("importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data.garden || !Array.isArray(data.plantings) || !Array.isArray(data.garden.shape)) throw new Error();
      if (!confirm("Remplacer les données actuelles par ce fichier ?")) return;
      S = { ...emptyState(), ...data, weather: [], current: null, weatherAt: 0, setupDone: true };
      save(); render(); refreshWeather(true);
      toast("Sauvegarde importée.");
    } catch (err) { toast("Ce fichier n'est pas une sauvegarde de l'app.", true); }
  });

  // Affiche le détail d'une barre du graphique au toucher comme au survol.
  const showTip = (e) => {
    const g = e.target.closest && e.target.closest("[data-tip]"), tip = $("chartTip");
    if (g && tip) tip.textContent = g.dataset.tip;
  };
  document.addEventListener("pointerover", showTip);
  document.addEventListener("pointerdown", showTip);

  document.addEventListener("visibilitychange", () => { if (!document.hidden && S.setupDone) refreshWeather(false); });
  window.addEventListener("online", () => { if (S.setupDone) refreshWeather(false); });
  window.addEventListener("resize", () => drawPlan());

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  render();
  if (S.setupDone) refreshWeather(false);
})();
