# Deploiement Docker

1. Copier `.env.example` vers `.env` et definir `SESSION_SECRET`.
2. Construire et lancer:

```bash
docker compose up -d --build
```

3. Application disponible sur `http://localhost:3000`.

Les donnees persistantes sont stockees dans deux volumes Docker:

- `audioboard_data` pour SQLite
- `audioboard_uploads` pour les fichiers audio et pochettes

Arreter le service:

```bash
docker compose down
```
