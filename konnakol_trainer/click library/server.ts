import express from "express";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import path from "path";

async function startServer() {
  const app = express();
  const PORT = 3000;
  
  app.use(express.json());

  // API route to save the config JSON
  app.post("/api/save-tuning", (req, res) => {
    try {
      const data = req.body;
      const filePath = path.join(process.cwd(), "src/audio", "tuned-sounds.json");
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
      res.json({ status: "ok", message: "Saved to src/audio/tuned-sounds.json" });
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ status: "error", message: e.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
