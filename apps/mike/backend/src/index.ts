import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { chatRouter } from "./routes/chat";
import { projectsRouter } from "./routes/projects";
import { projectChatRouter } from "./routes/projectChat";
import { documentsRouter } from "./routes/documents";
import { tabularRouter } from "./routes/tabular";
import { workflowsRouter } from "./routes/workflows";
import { userRouter } from "./routes/user";
import { downloadsRouter } from "./routes/downloads";
import { signingRouter } from "./routes/signing";
import { checkOllamaHealth } from "./lib/llm";
import { checkAutoYouRuntime } from "./lib/autoyouRuntime";
import {
  isOpenSignConfigured,
  isOpenSignWebhookSecretRequired,
  openSignApiMode,
} from "./lib/signing/opensign";

export const app = express();
const PORT = process.env.PORT ?? 3001;
const isProduction = process.env.NODE_ENV === "production";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function minutes(value: number): number {
  return value * 60 * 1000;
}

function hours(value: number): number {
  return minutes(value * 60);
}

function publicMikeApiBaseUrl(): string | null {
  const value =
    process.env.MIKE_PUBLIC_API_BASE_URL?.trim() ||
    process.env.PUBLIC_API_BASE_URL?.trim() ||
    process.env.BACKEND_PUBLIC_URL?.trim() ||
    process.env.API_PUBLIC_URL?.trim() ||
    "";
  return value ? value.replace(/\/+$/, "") : null;
}

function isLocalUrl(value: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(
    value,
  );
}

function isPublicHttpsUrl(value: string | null): boolean {
  return !!value && /^https:\/\//i.test(value) && !isLocalUrl(value);
}

function envTruthy(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(
    process.env[name]?.trim().toLowerCase() ?? "",
  );
}

function makeLimiter(options: {
  windowMs: number;
  max: number;
  message?: string;
}) {
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === "OPTIONS",
    message: {
      detail: options.message ?? "Too many requests. Please try again later.",
    },
  });
}

const generalLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_GENERAL_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_GENERAL_MAX", 300),
});

const chatLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_CHAT_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_CHAT_MAX", 30),
  message: "Too many chat requests. Please try again later.",
});

const chatCreateLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_CHAT_CREATE_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_CHAT_CREATE_MAX", 60),
});

const uploadLimiter = makeLimiter({
  windowMs: hours(envInt("RATE_LIMIT_UPLOAD_WINDOW_HOURS", 1)),
  max: envInt("RATE_LIMIT_UPLOAD_MAX", 50),
  message: "Too many upload requests. Please try again later.",
});

app.disable("x-powered-by");
app.set("trust proxy", envInt("TRUST_PROXY_HOPS", 1));

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    hsts: isProduction
      ? {
          maxAge: 15552000,
          includeSubDomains: true,
        }
      : false,
    referrerPolicy: { policy: "no-referrer" },
  }),
);

app.use(
  cors({
    origin: corsOrigins(),
    credentials: true,
  }),
);

app.use(generalLimiter);

app.use(
  express.json({
    limit: "50mb",
    verify: (req, _res, buf) => {
      const requestWithBody = req as typeof req & {
        originalUrl?: string;
        rawBody?: Buffer;
        url?: string;
      };
      const url = requestWithBody.originalUrl ?? requestWithBody.url ?? "";
      if (url.startsWith("/webhooks/signing/")) {
        requestWithBody.rawBody = Buffer.from(buf);
      }
    },
  }),
);

app.post("/chat", chatLimiter);
app.post("/projects/:projectId/chat", chatLimiter);
app.post("/tabular-review/:reviewId/chat", chatLimiter);
app.post("/tabular-review/:reviewId/generate", chatLimiter);
app.post("/chat/create", chatCreateLimiter);
app.post("/chat/:chatId/generate-title", chatCreateLimiter);
app.post("/single-documents", uploadLimiter);
app.post("/single-documents/:documentId/versions", uploadLimiter);
app.post("/single-documents/:documentId/signature-requests", uploadLimiter);
app.post("/projects/:projectId/documents", uploadLimiter);

app.use("/chat", chatRouter);
app.use("/projects", projectsRouter);
app.use("/projects/:projectId/chat", projectChatRouter);
app.use("/single-documents", documentsRouter);
app.use("/tabular-review", tabularRouter);
app.use("/workflows", workflowsRouter);
app.use("/user", userRouter);
app.use("/users", userRouter);
app.use("/download", downloadsRouter);
app.use("/", signingRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/health/integrations", async (_req, res) => {
  const [ollama, autoyouRuntime] = await Promise.all([
    checkOllamaHealth(),
    checkAutoYouRuntime(),
  ]);
  const publicApiBase = publicMikeApiBaseUrl();
  const webhookTarget = publicApiBase
    ? `${publicApiBase}/webhooks/signing/opensign`
    : null;
  const opensignMode = openSignApiMode();
  const opensignConfigured = isOpenSignConfigured();
  const webhookSecretConfigured =
    !!process.env.OPENSIGN_WEBHOOK_SECRET?.trim();
  const webhookSecretRequired = isOpenSignWebhookSecretRequired();
  const webhookTargetPublic = isPublicHttpsUrl(publicApiBase);
  const webhookReadyForPublic =
    webhookSecretRequired && webhookSecretConfigured && webhookTargetPublic;
  const selfHostEmailDeliveryConfigured =
    opensignMode === "selfhost"
      ? envTruthy("OPENSIGN_SELFHOST_EMAIL_CONFIGURED")
      : null;
  const selfHostEmailDeliveryRequired =
    opensignMode === "selfhost"
      ? envTruthy("OPENSIGN_SELFHOST_REQUIRE_EMAIL")
      : null;
  const emailDeliveryConfigured =
    opensignMode === "selfhost" ? selfHostEmailDeliveryConfigured : true;
  res.json({
    ok: true,
    ollama,
    autoyouRuntime,
    opensign: {
      configured: opensignConfigured,
      mode: opensignMode,
      webhookSecretConfigured,
      webhookSecretRequired,
      baseUrl:
        opensignMode === "selfhost"
          ? (process.env.OPENSIGN_PARSE_BASE_URL ??
            process.env.OPENSIGN_SELFHOST_API_BASE_URL ??
            null)
          : (process.env.OPENSIGN_API_BASE_URL ?? null),
      publicUrl:
        opensignMode === "selfhost"
          ? (process.env.OPENSIGN_PUBLIC_URL ??
            process.env.OPENSIGN_SELFHOST_PUBLIC_URL ??
            null)
          : null,
      provider: process.env.SIGNING_PROVIDER ?? "opensign",
      webhookTarget,
      webhookTargetPublic,
      webhookReadyForPublic,
      readyForPublicSigning: opensignConfigured && webhookReadyForPublic,
      emailDeliveryConfigured,
      emailDeliveryRequired: selfHostEmailDeliveryRequired,
      readyForPublicEmailSigning:
        opensignConfigured && webhookReadyForPublic && emailDeliveryConfigured,
    },
  });
});

export function startServer(port: string | number = PORT) {
  return app.listen(port, () => {
    console.log(`Mike backend running on port ${port}`);
  });
}

function corsOrigins(): string[] {
  const configured = (process.env.FRONTEND_URL ?? "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const origins = new Set(configured);
  if (!isProduction) {
    origins.add("http://localhost:3000");
    origins.add("http://127.0.0.1:3000");
  }
  return Array.from(origins);
}

if (require.main === module) {
  startServer();
}
