# Mon Jardin

Application de gestion de jardin, installable sur téléphone : plan 2D du terrain, météo en direct, conseils d'arrosage et de plantation.

App : https://boydeathmonsters.github.io/jardin/

## Installer sur le téléphone

- **iPhone :** ouvre l'adresse dans Safari, puis **Partager > Sur l'écran d'accueil**.
- **Android :** ouvre l'adresse dans Chrome, puis **⋮ > Installer l'application** ou **Ajouter à l'écran d'accueil**.

Ouvre ensuite l'app depuis son icône et configure ton jardin. Sur iPhone, l'app installée et Safari ne partagent pas leurs données : configure-la bien depuis l'icône.

## Données

Tout reste sur le téléphone, dans le stockage local de l'app. Il n'y a ni compte ni serveur. Le bouton **Jardin > Sauvegarde > Exporter** crée un fichier pour changer de téléphone ou se protéger d'une perte.

Seules les coordonnées du jardin quittent le téléphone, pour interroger :

- [Open-Meteo](https://open-meteo.com/) : prévisions, sol, 15 ans d'historique et recherche de commune ;
- [SoilGrids](https://soilgrids.org/) (ISRIC) : estimation du sol, seulement si tu touches le bouton dédié. En ville, la carte est vide : l'app prend le point le plus proche et l'indique.

## Comment les conseils sont calculés

- **Arrosage :** bilan hydrique quotidien FAO-56 pour chaque culture. Il tient compte de l'évapotranspiration, du coefficient cultural selon le stade, de la réserve utile du sol, de la profondeur des racines, de la pluie reçue et annoncée, du soleil, du vent, du paillage, de la serre et des arrosages notés.
- **Calendrier :** fenêtres de semis et de plantation exprimées par rapport aux dates de gel du lieu, calculées sur 15 ans et ajustées au microclimat.
- **Puis-je planter ? :** période, température du sol, gel et chaleur annoncés, temps de culture restant, rusticité, pH, texture, drainage, profondeur, lumière, voisins et rotation.
- **Alertes :** gel ciblé sur les plantes menacées, canicule, vent, grêle, mildiou, oïdium, limaces, récoltes et soins.

Ce sont des estimations à partir de données à l'échelle de la commune : le jardin garde le dernier mot. Les associations de plantes sont des repères traditionnels, pas des résultats scientifiques.

## Développement

Site statique sans dépendance : `plants.js` (base de plantes), `engine.js` (calculs sans accès à l'écran), `app.js` (interface). Il suffit de servir le dossier :

```bash
python -m http.server 8765
```
