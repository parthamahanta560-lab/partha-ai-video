
import express from "express";

const app = express();
app.use(express.json({ limit: "10mb" }));

const FAL_KEY = process.env.FAL_KEY;
const APP_TOKEN = process.env.APP_TOKEN;
const ALLOWED_MODELS = (process.env.ALLOWED_MODELS || "fal-ai/veo3.1")
  .split(",")
  .map(x => x.trim());

app.get("/", (req, res) => {
  res.json({ service: "PARTHA AI VIDEO Backend", status: "online" });
});

// Simple app-token protection
function checkAuth(req, res, next) {
  if (!APP_TOKEN || req.headers.authorization !== `Bearer ${APP_TOKEN}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Submit a video-generation request
app.post("/api/submit", checkAuth, async (req, res) => {
  try {
    const { modelId, input } = req.body;

    if (!ALLOWED_MODELS.includes(modelId)) {
      return res.status(400).json({ error: "Model not allowed" });
    }

    if (!input || typeof input.prompt !== "string" || !input.prompt.trim()) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const response = await fetch(`https://queue.fal.run/${modelId}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${FAL_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input)
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ error: "Request failed" });
  }
});

// Check request status
app.get("/api/status/:modelId/:requestId", checkAuth, async (req, res) => {
  try {
    const { modelId, requestId } = req.params;

    if (!ALLOWED_MODELS.includes(modelId)) {
      return res.status(400).json({ error: "Model not allowed" });
    }

    const response = await fetch(
      `https://queue.fal.run/${modelId}/requests/${requestId}/status`,
      { headers: { Authorization: `Key ${FAL_KEY}` } }
    );

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ error: "Status check failed" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Backend running on port ${port}`));
