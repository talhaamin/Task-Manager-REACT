# Smart Task Manager (React + Vite + TypeScript + Tailwind)

This is a minimal frontend wired to an API at `http://localhost:3001/api`.
It supports natural-language task input and optional Web Push reminders.

## Quick start

```bash
npm install
npm run dev
```

The service worker for push notifications is at `/sw.js`. Ensure your backend serves the app from the site root so `/sw.js` is reachable, and exposes endpoints:

- `GET    /api/tasks`
- `POST   /api/tasks`           body: `{ input: string }`
- `PUT    /api/tasks/:id`       body: `{ input?: string, completed?: boolean }`
- `DELETE /api/tasks/:id`
- `POST   /api/push/subscribe`  body: PushSubscription

> The VAPID public key is included in the code. Use your own in production.
