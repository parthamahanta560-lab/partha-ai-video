import express from "express";

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "50mb" }));

const FAL_KEY = process.env.FAL_KEY;
const APP_TOKEN = process.env.APP_TOKEN;
const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = 60000;

const ALLOWED_MODELS = (process.env.ALLOWED_MODELS || "fal-ai/veo3.1")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

// ---------------- CORS ----------------

const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// ---------------- Helpers ----------------

function sendError(res, status, error, details) {
  return res.status(status).json({
    success: false,
    error,
    ...(details ? { details } : {})
  });
}

function checkAuth(req, res, next) {
  if (!APP_TOKEN) {
    return sendError(res, 500, "APP_TOKEN is not configured");
  }

  const auth = req.headers.authorization;

  if (auth !== `Bearer ${APP_TOKEN}`) {
    return sendError(res, 401, "Unauthorized");
  }

  next();
}

function validModel(modelId) {
  return typeof modelId === "string" &&
    ALLOWED_MODELS.includes(modelId);
}

function validRequestId(requestId) {
  return /^[a-zA-Z0-9_-]+$/.test(requestId);
}

function falHeaders() {
  return {
    Authorization: `Key ${FAL_KEY}`,
    "Content-Type": "application/json"
  };
}

function falBase(modelId) {
  return `https://queue.fal.run/${modelId}`;
}

function safeError(data) {
  if (!data) return "Unknown fal.ai error";

  if (typeof data === "string") return data;

  if (data.detail) {
    return typeof data.detail === "string"
      ? data.detail
      : JSON.stringify(data.detail);
  }

  return data.error || data.message || JSON.stringify(data);
}

// Timeout-protected fetch
async function falFetch(url, options = {}) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    const raw = await response.text();

    let data;

    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { raw };
    }

    return { response, data };
  } finally {
    clearTimeout(timeout);
  }
}

// Validate common request data
function validateRequest(res, modelId, requestId) {
  if (!FAL_KEY) {
    sendError(res, 500, "FAL_KEY is missing on server");
    return false;
  }

  if (!validModel(modelId)) {
    sendError(res, 400, "Model not allowed", {
      allowedModels: ALLOWED_MODELS
    });
    return false;
  }

  if (!validRequestId(requestId)) {
    sendError(res, 400, "Invalid request ID");
    return false;
  }

  return true;
}

// ---------------- Home ----------------

app.get("/", (req, res) => {
  res.json({
    service: "PARTHA AI VIDEO Backend",
    status: "online"
  });
});

// ---------------- Health ----------------

app.get("/v1/health", (req, res) => {
  res.json({
    status: "ok",
    service: "PARTHA AI VIDEO Backend",
    keyConfigured: Boolean(FAL_KEY),
    tokenConfigured: Boolean(APP_TOKEN),
    allowedModels: ALLOWED_MODELS
  });
});

// ---------------- Submit ----------------

app.post("/api/submit", checkAuth, async (req, res) => {
  try {
    if (!FAL_KEY) {
      return sendError(res, 500, "FAL_KEY is missing on server");
    }

    const { modelId, input } = req.body || {};

    if (!validModel(modelId)) {
      return sendError(res, 400, "Model not allowed", {
        allowedModels: ALLOWED_MODELS
      });
    }

    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return sendError(res, 400, "Input object is required");
    }

    if (
      typeof input.prompt !== "string" ||
      !input.prompt.trim()
    ) {
      return sendError(res, 400, "Prompt is required");
    }

    const { response, data } = await falFetch(
      falBase(modelId),
      {
        method: "POST",
        headers: {
          ...falHeaders(),
          "X-Fal-No-Retry": "1"
        },
        body: JSON.stringify(input)
      }
    );

    if (!response.ok) {
      console.error("FAL SUBMIT ERROR:", response.status, data);

      return sendError(
        res,
        response.status,
        "fal.ai rejected the request",
        safeError(data)
      );
    }

    return res.status(response.status).json({
      success: true,
      ...data
    });

  } catch (error) {
    console.error("SUBMIT ERROR:", error);

    if (error.name === "AbortError") {
      return sendError(res, 504, "fal.ai submit timeout");
    }

    return sendError(res, 500, "Video submission failed", error.message);
  }
});

// ---------------- Status ----------------

app.get("/api/status/:modelId/:requestId", checkAuth, async (req, res) => {
  try {
    const { modelId, requestId } = req.params;

    if (!validateRequest(res, modelId, requestId)) return;

    const url =
      `${falBase(modelId)}/requests/${requestId}/status`;

    const { response, data } = await falFetch(url, {
      headers: {
        Authorization: `Key ${FAL_KEY}`
      }
    });

    if (!response.ok) {
      return sendError(
        res,
        response.status,
        "Status check failed",
        safeError(data)
      );
    }

    return res.json({
      success: true,
      ...data
    });

  } catch (error) {
    console.error("STATUS ERROR:", error);

    if (error.name === "AbortError") {
      return sendError(res, 504, "Status request timeout");
    }

    return sendError(res, 500, "Status check failed", error.message);
  }
});

// ---------------- Result ----------------

app.get("/api/result/:modelId/:requestId", checkAuth, async (req, res) => {
  try {
    const { modelId, requestId } = req.params;

    if (!validateRequest(res, modelId, requestId)) return;

    const url =
      `${falBase(modelId)}/requests/${requestId}`;

    const { response, data } = await falFetch(url, {
      headers: {
        Authorization: `Key ${FAL_KEY}`
      }
    });

    if (!response.ok) {
      return sendError(
        res,
        response.status,
        "Result retrieval failed",
        safeError(data)
      );
    }

    return res.json({
      success: true,
      ...data
    });

  } catch (error) {
    console.error("RESULT ERROR:", error);

    if (error.name === "AbortError") {
      return sendError(res, 504, "Result request timeout");
    }

    return sendError(res, 500, "Result retrieval failed", error.message);
  }
});

// ---------------- Cancel ----------------

app.post("/api/cancel/:modelId/:requestId", checkAuth, async (req, res) => {
  try {
    const { modelId, requestId } = req.params;

    if (!validateRequest(res, modelId, requestId)) return;

    const url =
      `${falBase(modelId)}/requests/${requestId}/cancel`;

    const { response, data } = await falFetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Key ${FAL_KEY}`
      }
    });

    if (!response.ok) {
      return sendError(
        res,
        response.status,
        "Cancel failed",
        safeError(data)
      );
    }

    return res.status(response.status).json({
      success: true,
      ...data
    });

  } catch (error) {
    console.error("CANCEL ERROR:", error);

    if (error.name === "AbortError") {
      return sendError(res, 504, "Cancel request timeout");
    }

    return sendError(res, 500, "Cancel request failed", error.message);
  }
});

// ---------------- JSON errors ----------------

app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);

  if (err.type === "entity.too.large") {
    return sendError(res, 413, "Payload too large. Reduce image size.");
  }

  if (err instanceof SyntaxError && err.status === 400) {
    return sendError(res, 400, "Invalid JSON");
  }

  return sendError(res, 500, "Internal server error");
});

// ---------------- Start ----------------

app.listen(PORT, () => {
  console.log(`PARTHA AI VIDEO Backend running on port ${PORT}`);
});
