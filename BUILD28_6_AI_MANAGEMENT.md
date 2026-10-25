# TABLELY Build 28.6 — AI Provider Management

Build 28.6 adds a centralized server-side AI service, platform-admin provider/model/routing controls, sanitized usage diagnostics, and a database migration. It integrates menu photo and searchable-PDF extraction with the same validated menu draft pipeline.

## Migration and environment

Apply `supabase/migrations/20261024000500_build28_6_ai_provider_management.sql` through the normal reviewed migration workflow. The migration is additive and is **not applied to production by this source change**. All new `public` tables have RLS enabled and no privileges granted to `anon` or `authenticated`; app server routes use the service role only after validating the user's session and `is_platform_admin()`.

Keep `TABLELY_ENCRYPTION_KEY` configured as a protected server secret. It must be the existing 32-byte base64 key used by the restaurant payment encryption helper. Provider API keys are encrypted with the existing AES-256-GCM utility. The admin API returns a masked suffix and credential status only. Never expose service-role keys, the encryption key or provider credentials through `NEXT_PUBLIC_*` variables.

Required app server configuration:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SERVICE_ROLE_KEY=
TABLELY_ENCRYPTION_KEY=
```

The admin route is `/admin/ai-management`. It supports OpenAI-compatible endpoints (OpenRouter, OpenAI, DeepSeek, Groq, Mistral, Together AI, Fireworks AI, and configured custom endpoints), native Gemini, and native Anthropic protocols. A custom endpoint must be HTTPS and cannot point to local/private IP targets. Model discovery calls each provider's model-list endpoint where available; manual model IDs remain supported. A model must be enabled and explicitly approved before routing can use it. Capability flags are administrator assertions and should be checked against provider documentation and connection behavior.

## Simple setup in Admin

1. Open **Admin → AI management**, choose the provider, paste its API key and connect it. Common providers have working endpoint and protocol defaults.
2. Add a model by entering its model ID, or use **Find model** on a saved provider to prefill one. Saving a model from this administrator-only page enables and approves it for routing. Confirm the provider's model ID and capabilities before use.
3. Under **Choose what AI can do**, select the model and enable only the feature routes needed. Hindi and Bengali menu translations use the Menu extraction route. Fallbacks and per-route limits are optional advanced settings.
4. Use **Test** on a saved provider to make a small real provider request. This may consume provider credits. It checks the model's text request path but does not prove image extraction support. Validate image capability with a controlled manual import and monitor its result.

The page keeps provider endpoint overrides, model capabilities and pricing, fallback selection, global limits, and recent diagnostics under expandable advanced sections. Pricing is an administrator-maintained estimate, not live billing data.

Customer menu translation to Hindi or Bengali reuses the same **Menu extraction** route, approved text model, provider credentials and ordered fallbacks. No separate Menu translation route is required. Dashboard → Menu prepares and stores missing Hindi and Bengali translations, and invalidates those saved rows when source names or descriptions change. Customer language selection reads saved translation rows from the public menu RPC and never invokes AI. Translation usage is recorded under `menu_translation`; the shared route's daily limit counts both extraction and translation requests.

The public menu RPC also includes translated variants and modifier groups. Its menu-option aggregations use `LATERAL` subqueries in `supabase/migrations/20261024140000_build32_public_variant_translations.sql`; apply migrations in timestamp order. This keeps nested translation aggregation readable and avoids malformed select-list parentheses.

Restaurant and customer assistants reuse the configured **Business assistant** and **Restaurant analytics** routes. The dashboard assistant has Support and Analytics tabs; Analytics requests require branch `ANALYTICS` permission and use the existing plan-gated branch aggregate RPCs. The customer QR popup separates Chat with restaurant from Ask AI suggestions. Customer suggestions receive only the active QR restaurant's public menu and aggregate popularity from paid orders in the previous 90 days (minimum three distinct orders per dish); dish-level ratings are unavailable and must not be claimed.

Apply `supabase/migrations/20261025020000_restaurant_ai_assistant.sql` before enabling assistant routes. Every staff or customer AI request atomically reserves usage against its resolved restaurant organization: at most 30 requests and 12,000 reserved output tokens per UTC day, with no more than 400 output tokens per response. Input questions are length-bounded, assistant history is short and ephemeral, and prompts are not persisted. Customer menu/popularity context is resolved server-side from the QR table code; client-supplied tenant IDs are not accepted. Quota is shared across the restaurant's branches and both audiences. A failed provider attempt still consumes a request, preventing retries from bypassing the cap.

The menu extraction service checks admin routing first, validates provider/model active and approval state, enforces the configured feature/file/request limits, applies provider timeout and retry limits, and falls back only after retryable rate-limit, timeout, network, or provider-availability failures. Authentication, quota and unsupported-model errors do not trigger fallback. Each attempt records token counts, latency, estimated cost when both prices are set, success, fallback index, and a sanitized error category; prompts, files, keys and provider response bodies are never logged.

The menu importer uses legacy `TABLELY_MENU_AI_API_KEY` / `OPENAI_API_KEY` settings only while no database-backed extraction route is active. Database settings take precedence; the admin page warns when legacy settings are present. After migrating credentials into the admin panel, remove old runtime provider variables from each deployment environment. CSV/XLSX imports and deterministic searchable-PDF parsing continue to work without AI.

## AI regression tests

Run `npm run test:ai` for the AI-focused suite. It covers mocked menu-photo extraction, provider protocol/routing contracts, translation batching and persistence guards, staff branch/analytics authorization, QR-scoped customer suggestions, AI administrator credential handling, and restaurant-level quota contracts. Automated tests do not send requests to real AI providers; provider response tests use a mocked `fetch`.

## Limits and known behavior

Admins can set a monthly estimated-cost ceiling, daily request ceilings, token limits and file-size limits. Cost is calculated only from configured prices and provider-reported token usage; requests with unknown usage/pricing cannot be accurately estimated. The budget check uses recorded successful request costs and therefore should be treated as an estimate, not a hard provider-side spend cap. Configure limits with that caveat and also set provider-side billing limits. Restaurant assistants have an additional database-enforced per-restaurant daily request and output-token ceiling. AI failures do not participate in restaurant checkout/payment paths.

The native Gemini and Anthropic adapters normalize text responses to the existing menu draft shape. OpenAI-compatible is used only with endpoints that implement that protocol. Provider API formats can change; verify current provider requirements before enabling a model. No real provider request is run by automated tests.

## Troubleshooting

- **No active provider/model:** verify provider enabled + credential saved, model enabled + approved, route enabled, and route primary set.
- **Image model rejected:** verify the actual model supports image input and the model's image capability is selected; the model list alone is not proof.
- **Credential cannot decrypt:** verify `TABLELY_ENCRYPTION_KEY` is the original 32-byte base64 value on every app instance, then rotate/save the provider credential again if that key changed.
- **Model discovery unavailable:** enter the provider's documented model identifier manually and configure capabilities/pricing yourself.
- **Usage cost is blank:** configure both input and output prices for that model. Values are the admin's per-million-token estimate in the deployment's configured currency.
- **Legacy configuration warning:** move the credential and model to database-backed settings, validate routing, then remove legacy environment variables.
