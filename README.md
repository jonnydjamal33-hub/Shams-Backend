# Shams Mobile API

API Express/MongoDB consommée par l'application Flutter du dossier `shams`.

## Démarrage local

Prérequis : Node.js 20+ et MongoDB local ou Atlas.

```powershell
cd backend-shams
npm install
Copy-Item .env.example .env
```

Renseignez `MONGODB_URI` et remplacez `JWT_SECRET` par une valeur aléatoire longue dans `.env`, puis lancez :

```powershell
npm run dev
```

L'API écoute sur `http://localhost:5000`. Vérifiez `GET /health`.

L'émulateur Android joint l'hôte avec `http://10.0.2.2:5000` (URL Flutter par défaut). Pour un téléphone physique, utilisez l'adresse IP LAN de l'ordinateur; pour iOS/web, utilisez `http://localhost:5000`.

```powershell
cd shams
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:5000
```

## Routes mobiles

- Authentification : `POST /api/auth/register`, `/login`, `/google`, `/facebook`. Toute création publique locale ou OAuth produit un compte `CLIENT`; aucune connexion ne promeut un compte par son adresse e-mail. Les adresses de `ADMIN_EMAILS` sont réservées et refusées par l'inscription locale.
- Provisionnement admin : après vérification de l'identité par l'opérateur, attribuez `role: "ADMIN"` et `adminApproved: true` au compte voulu directement via un outil d'administration MongoDB sécurisé. Ne réutilisez pas un compte/client dont l'identité n'a pas été vérifiée. Le champ `adminApproved` est exigé par la connexion, les routes REST et Socket.IO; les comptes `ADMIN` existants sans approbation sont donc bloqués jusqu'à revue manuelle. Aucun endpoint public ne modifie ces champs.
- Consultations : `GET /api/consultations` (crée/récupère le salon du client ou liste les salons côté admin), `GET/POST /api/consultations/:id/messages`; la gestion de statut est admin uniquement.
- Socket.IO : connexion avec `auth: { token: "<JWT>" }`, puis événement `consultation:join` avec `{ consultationId }`. Envoi par `message:send` avec `{ consultationId, contenu }`; événements entrants `message:new`, `consultation:new` et `consultation:message`.
- Rituels : `GET /api/rituals`; CRUD admin avec `POST/PUT/DELETE /api/rituals/:id`. Les clients commandent via `POST /api/rituals/:id/orders` et suivent leurs commandes sur `/api/rituals/orders/mine`. L’administration traite les demandes sur `GET /api/rituals/orders` et `PUT /api/rituals/orders/:id/status`; un compte-rendu est obligatoire pour le statut `TERMINE`.
- Géomancie : `POST /api/geomancy/readings` avec `{ question }`, et historique utilisateur par `GET /api/geomancy/readings`. Les figures sont générées côté serveur.

La géomancie et les commandes de rituels sont enregistrées par compte utilisateur. Le stockage local des photos de profil convient au développement seulement; utilisez un stockage persistant (par exemple S3/Cloud Storage) en production.

Les requêtes privées utilisent `Authorization: Bearer <JWT>`. Les erreurs JSON ont la forme `{ "message": "..." }`. Les sockets vérifient le même JWT et l'accès à chaque consultation.