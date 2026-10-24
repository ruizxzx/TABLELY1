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

## Configure a provider and route

1. Open **Admin → AI management** and add a provider. Choose its matching protocol and endpoint, save a key, and enable it.
2. Use **Discover** to fetch model IDs or enter one manually. Configure capabilities and optional per-million-token pricing. Pricing is an administrator-maintained estimate, not live billing data.
3. Enable and approve the model after confirming provider support. Mark `image` true only for a model that accepts image input.
4. Set the primary model and ordered fallback models in the Menu extraction route, then enable the route.
5. Use **Test** to send a small real request to the first enabled saved model for that provider. This may consume provider credits. It checks the model's text request path but does not prove image extraction support. Validate image capability with a controlled manual import and monitor its result.

Customer menu translation to Hindi or Bengali reuses the same **Menu extraction** route, approved text model, provider credentials and ordered fallbacks. No separate Menu translation route is required. Dashboard → Menu prepares and stores missing Hindi and Bengali translations, and invalidates those saved rows when source names or descriptions change. Customer language selection reads saved translation rows from the public menu RPC and never invokes AI. Translation usage is recorded under `menu_translation`; the shared route's daily limit counts both extraction and translation requests.

The menu extraction service checks admin routing first, validates provider/model active and approval state, enforces the configured feature/file/request limits, applies provider timeout and retry limits, and falls back only after retryable rate-limit, timeout, network, or provider-availability failures. Authentication, quota and unsupported-model errors do not trigger fallback. Each attempt records token counts, latency, estimated cost when both prices are set, success, fallback index, and a sanitized error category; prompts, files, keys and provider response bodies are never logged.

The menu importer uses legacy `TABLELY_MENU_AI_API_KEY` / `OPENAI_API_KEY` settings only while no database-backed extraction route is active. Database settings take precedence; the admin page warns when legacy settings are present. After migrating credentials into the admin panel, remove old runtime provider variables from each deployment environment. CSV/XLSX imports and deterministic searchable-PDF parsing continue to work without AI.

## Limits and known behavior

Admins can set a monthly estimated-cost ceiling, daily request ceilings, token limits and file-size limits. Cost is calculated only from configured prices and provider-reported token usage; requests with unknown usage/pricing cannot be accurately estimated. The budget check uses recorded successful request costs and therefore should be treated as an estimate, not a hard provider-side spend cap. Configure limits with that caveat and also set provider-side billing limits. AI failures are confined to AI menu extraction and do not participate in restaurant checkout/payment paths.

The native Gemini and Anthropic adapters normalize text responses to the existing menu draft shape. OpenAI-compatible is used only with endpoints that implement that protocol. Provider API formats can change; verify current provider requirements before enabling a model. No real provider request is run by automated tests.

## Troubleshooting

- **No active provider/model:** verify provider enabled + credential saved, model enabled + approved, route enabled, and route primary set.
- **Image model rejected:** verify the actual model supports image input and the model's image capability is selected; the model list alone is not proof.
- **Credential cannot decrypt:** verify `TABLELY_ENCRYPTION_KEY` is the original 32-byte base64 value on every app instance, then rotate/save the provider credential again if that key changed.
- **Model discovery unavailable:** enter the provider's documented model identifier manually and configure capabilities/pricing yourself.
- **Usage cost is blank:** configure both input and output prices for that model. Values are the admin's per-million-token estimate in the deployment's configured currency.
- **Legacy configuration warning:** move the credential and model to database-backed settings, validate routing, then remove legacy environment variables.
