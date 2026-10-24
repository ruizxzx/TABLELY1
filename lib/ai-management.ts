import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { decryptSecret } from '@/lib/restaurant-payment';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

type Provider = { id:string; name:string; slug:string; provider_type:string; protocol:'openai'|'gemini'|'anthropic'; base_url:string; api_version:string|null; organization_id:string|null; credential_encrypted:string|null; enabled:boolean; timeout_ms:number; retry_limit:number; max_requests_per_minute:number };
type Model = { id:string; provider_id:string; model_key:string; display_name:string; capabilities:Record<string,boolean>; max_output_tokens:number|null; input_price_per_million:number|null; output_price_per_million:number|null; enabled:boolean; approved:boolean };
type Route = { feature_key:string; primary_model_id:string|null; fallback_model_ids:string[]; enabled:boolean; max_tokens:number; daily_request_limit:number|null; max_file_bytes:number };
export type AiContent = string | { mimeType:string; base64:string };

function db() { const client=getSupabaseAdminClient(); if(!client) throw new Error('AI management database is not configured.'); return client; }
export async function hasMenuExtractionRoute() { const admin=getSupabaseAdminClient();if(admin){const{data}=await admin.from('platform_ai_routes').select('enabled,primary_model_id').eq('feature_key','menu_extraction').maybeSingle();if(data?.enabled&&data.primary_model_id)return true;}return Boolean(process.env.TABLELY_MENU_AI_API_KEY?.trim()||process.env.OPENAI_API_KEY?.trim()); }
export async function hasDatabaseMenuExtractionRoute() { const admin=getSupabaseAdminClient();if(!admin)return false;const{data}=await admin.from('platform_ai_routes').select('enabled,primary_model_id').eq('feature_key','menu_extraction').maybeSingle();return Boolean(data?.enabled&&data.primary_model_id); }
export function validateAiBaseUrl(url:string) { const parsed=new URL(url); const host=parsed.hostname.toLowerCase().replace(/^\[|\]$/g,''); if(!['https:','http:'].includes(parsed.protocol)||parsed.username||parsed.password) throw new Error('Provider endpoint must be an HTTP(S) URL without embedded credentials.');if(parsed.protocol==='http:')throw new Error('Provider endpoints must use HTTPS.');if(host==='localhost'||host.endsWith('.local')||host.endsWith('.internal'))throw new Error('Provider endpoint cannot target a local hostname.');const ip=isIP(host);if(ip===4&&(/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)))throw new Error('Provider endpoint cannot target a private IP address.');if(ip===6&&(host==='::1'||host.startsWith('fc')||host.startsWith('fd')||host.startsWith('fe80:')))throw new Error('Provider endpoint cannot target a private IP address.');return url.replace(/\/+$/,''); }
function safeBase(url:string) { return validateAiBaseUrl(url); }
function category(status:number, body:string) { if(status===401||status===403)return 'authentication'; if(status===404||/model.{0,30}(not found|unavailable|does not exist)/i.test(body))return 'model_or_endpoint'; if(status===429)return 'rate_limit'; if(/quota|credit|billing|insufficient balance/i.test(body))return 'quota'; if(status>=500)return 'provider_unavailable'; if(status===400||status===422)return 'invalid_request'; return 'provider_error'; }
function temporary(error:string) { return ['rate_limit','provider_unavailable','timeout','network'].includes(error); }
function fallbackEligible(error:string) { return temporary(error)||['provider_error','model_or_endpoint','invalid_request','invalid_response'].includes(error); }
async function providerRequest(provider:Provider, model:Model, key:string, content:AiContent, maxTokens:number, taskPrompt?:string, systemPrompt?:string) {
  const base=safeBase(provider.base_url), prompt=taskPrompt??'Extract restaurant menu items from the supplied menu. Return JSON only: {"items":[{"name":"","description":null,"category":"Uncategorized","price":null,"is_veg":null,"confidence":0.0,"variants":[],"modifier_groups":[]}]}. Extract only stated facts; never invent missing prices or details.';
  const system=systemPrompt??'You are a precise menu data extraction engine. Output valid JSON only.';
  let url='', headers:Record<string,string>={'Content-Type':'application/json'}, body:unknown;
  if(provider.protocol==='openai') {
    url=`${base}/chat/completions`; headers.Authorization=`Bearer ${key}`;
    if(provider.provider_type==='openai'&&provider.organization_id) headers['OpenAI-Organization']=provider.organization_id;
    const userContent=typeof content==='string'?`${prompt}\n\n${content}`:[{type:'text',text:prompt},{type:'image_url',image_url:{url:`data:${content.mimeType};base64,${content.base64}`,detail:'high'}}];
    body={model:model.model_key,max_tokens:Math.min(maxTokens,model.max_output_tokens??maxTokens),temperature:0,response_format:{type:'json_object'},...(provider.provider_type==='openrouter'?{reasoning_effort:'none'}:{}),messages:[{role:'system',content:system},{role:'user',content:userContent}]};
  } else if(provider.protocol==='gemini') {
    url=`${base}/models/${encodeURIComponent(model.model_key)}:generateContent?key=${encodeURIComponent(key)}`;
    const parts=typeof content==='string'?[{text:`${system}\n\n${prompt}\n\n${content}`}]:[{text:system},{text:prompt},{inline_data:{mime_type:content.mimeType,data:content.base64}}];
    body={contents:[{parts}],generationConfig:{responseMimeType:'application/json',maxOutputTokens:Math.min(maxTokens,model.max_output_tokens??maxTokens),temperature:0}};
  } else {
    url=`${base}/messages`; headers['x-api-key']=key; headers['anthropic-version']=provider.api_version||'2023-06-01';
    const userContent=typeof content==='string'?`${prompt}\n\n${content}`:[{type:'text',text:prompt},{type:'image',source:{type:'base64',media_type:content.mimeType,data:content.base64}}];
    body={model:model.model_key,max_tokens:Math.min(maxTokens,model.max_output_tokens??maxTokens),temperature:0,system,messages:[{role:'user',content:userContent}]};
  }
  const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(provider.timeout_ms)});
  const raw=await response.text();
  if(!response.ok) { const err=category(response.status,raw.slice(0,1200)); throw Object.assign(new Error(err),{category:err,status:response.status}); }
  let json:Record<string,any>; try{json=JSON.parse(raw)}catch{throw Object.assign(new Error('invalid_response'),{category:'invalid_response'})}
  const output=provider.protocol==='openai'?json.choices?.[0]?.message?.content:provider.protocol==='gemini'?json.candidates?.[0]?.content?.parts?.map((p:{text?:string})=>p.text??'').join(''):json.content?.filter((p:{type:string})=>p.type==='text').map((p:{text?:string})=>p.text??'').join('');
  if(typeof output!=='string'||!output.trim())throw Object.assign(new Error('invalid_response'),{category:'invalid_response'});
  const cleaned=output.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''); let parsed:unknown;
  try{parsed=JSON.parse(cleaned)}catch{throw Object.assign(new Error('invalid_response'),{category:'invalid_response'})}
  const usage=json.usage??json.usageMetadata??{};
  const inputTokens=Number(usage.prompt_tokens??usage.promptTokenCount??usage.input_tokens??0)||0;
  const outputTokens=Number(usage.completion_tokens??usage.candidatesTokenCount??usage.output_tokens??0)||0;
  return {parsed,inputTokens,outputTokens};
}

export async function testAiProviderModel(providerId:string,modelId:string) {
  const admin=db();
  const[{data:provider},{data:model}]=await Promise.all([admin.from('platform_ai_providers').select('*').eq('id',providerId).maybeSingle(),admin.from('platform_ai_models').select('*').eq('id',modelId).eq('provider_id',providerId).maybeSingle()]);
  if(!provider||!model)throw new Error('Select a saved model belonging to this provider.');
  if(!provider.credential_encrypted)throw new Error('Provider has no saved credential.');
  const key=decryptSecret(provider.credential_encrypted);if(!key)throw new Error('Provider credential could not be decrypted.');
  const started=Date.now();
  try{
    const result=await providerRequest(provider as Provider,model as Model,key,'Return a JSON object confirming this connectivity test. Do not include any other text.',256);
    await admin.from('platform_ai_usage_logs').insert({request_id:randomUUID(),feature_key:'provider_test',provider_id:providerId,model_id:modelId,input_tokens:result.inputTokens,output_tokens:result.outputTokens,latency_ms:Date.now()-started,succeeded:true});
    await admin.from('platform_ai_providers').update({last_tested_at:new Date().toISOString(),last_test_status:'ok',credential_status:'configured'}).eq('id',providerId);
    return {ok:true};
  }catch(error){
    const e=error as Error&{category?:string;status?:number};const safe=e.category==='authentication'?'Authentication failed. Verify the API key.':e.category==='rate_limit'?'Provider rate limit exceeded.':e.category==='quota'?'Provider quota or credits are exhausted.':e.category==='model_or_endpoint'?'The selected model or endpoint was not found.':e.category==='invalid_request'?`Provider rejected the request (HTTP ${e.status??'4xx'}). Check the model ID and request format.`:e.category==='invalid_response'?'Provider returned a response that could not be parsed. Check model compatibility.':'Provider request failed. Check connectivity and model support.';
    await admin.from('platform_ai_usage_logs').insert({request_id:randomUUID(),feature_key:'provider_test',provider_id:providerId,model_id:modelId,latency_ms:Date.now()-started,succeeded:false,error_category:e.category??'provider_error'});
    await admin.from('platform_ai_providers').update({last_tested_at:new Date().toISOString(),last_test_status:e.category??'provider_error',credential_status:e.category==='authentication'?'invalid':'configured'}).eq('id',providerId);
    throw new Error(safe);
  }
}

async function executeConfiguredTextFeature(featureKey:'menu_extraction'|'menu_translation', content:AiContent, mode:'text'|'image', taskPrompt?:string, systemPrompt?:string, routingFeatureKey: 'menu_extraction'|'menu_translation'=featureKey) {
  const admin=db(), requestId=randomUUID();
  const [{data:route},{data:settings}] = await Promise.all([admin.from('platform_ai_routes').select('*').eq('feature_key',routingFeatureKey).maybeSingle(),admin.from('platform_ai_settings').select('*').eq('id',true).maybeSingle()]);
  const featureName=featureKey==='menu_translation'?'translation':'extraction';
  if(!route?.enabled||!route.primary_model_id) throw new Error(featureKey==='menu_translation'&&routingFeatureKey==='menu_extraction'
    ?'AI menu translation uses the Menu extraction route. Configure that route in TABLELY Admin → AI Management.'
    :`AI menu ${featureName} is not configured in TABLELY Admin → AI Management.`);
  const maxBytes=Number(route.max_file_bytes??settings?.max_file_bytes??15728640);
  const contentBytes=typeof content==='string'?Buffer.byteLength(content,'utf8'):Buffer.from(content.base64,'base64').length;
  if(contentBytes>maxBytes)throw new Error(`This request exceeds the configured AI menu ${featureName} size limit.`);
  const dailyStart=new Date();dailyStart.setHours(0,0,0,0);
  const {count:daily}=await admin.from('platform_ai_usage_logs').select('id',{count:'exact',head:true}).gte('created_at',dailyStart.toISOString());
  if(settings?.max_daily_requests!=null&&(daily??0)>=settings.max_daily_requests)throw new Error('The platform daily AI request limit has been reached.');
  const usageFeatureKeys=[...new Set([featureKey,routingFeatureKey])];
  const {count:featureDaily}=await admin.from('platform_ai_usage_logs').select('id',{count:'exact',head:true}).in('feature_key',usageFeatureKeys).gte('created_at',dailyStart.toISOString());
  if(route.daily_request_limit!=null&&(featureDaily??0)>=route.daily_request_limit)throw new Error(`The menu ${featureName} daily request limit has been reached.`);
  if(settings?.monthly_budget!=null){const monthStart=new Date();monthStart.setDate(1);monthStart.setHours(0,0,0,0);const{data:monthRows}=await admin.from('platform_ai_usage_logs').select('estimated_cost').gte('created_at',monthStart.toISOString()).eq('succeeded',true);const monthCost=(monthRows??[]).reduce((sum,row)=>sum+Number(row.estimated_cost??0),0);if(monthCost>=Number(settings.monthly_budget))throw new Error('The configured monthly AI budget has been reached.');}
  const ids=[route.primary_model_id,...(route.fallback_model_ids??[])];
  const {data:models,error:modelError}=await admin.from('platform_ai_models').select('*').in('id',ids).eq('enabled',true).eq('approved',true);
  if(modelError)throw new Error('AI routing configuration could not be loaded.');
  const indexed=new Map((models??[]).map((model:Model)=>[model.id,model]));
  for(const [index,id] of ids.entries()) {
    const model=indexed.get(id); if(!model)continue;
    if(!model.capabilities?.text||(mode==='image'&&!model.capabilities?.image))continue;
    const {data:provider}=await admin.from('platform_ai_providers').select('*').eq('id',model.provider_id).eq('enabled',true).maybeSingle() as {data:Provider|null};
    if(!provider||!provider.credential_encrypted)continue;
    const key=decryptSecret(provider.credential_encrypted); if(!key)throw new Error('AI provider credentials cannot be decrypted. Check TABLELY_ENCRYPTION_KEY.');
    const {count:minute}=await admin.from('platform_ai_usage_logs').select('id',{count:'exact',head:true}).eq('provider_id',provider.id).gte('created_at',new Date(Date.now()-60000).toISOString());
    if((minute??0)>=provider.max_requests_per_minute)continue;
    if(settings?.monthly_budget!=null){
      if(model.input_price_per_million==null||model.output_price_per_million==null)continue;
      const estimatedInputTokens=Math.ceil(contentBytes/4),estimatedOutputTokens=Math.min(route.max_tokens,settings.max_tokens_per_request??4096,model.max_output_tokens??route.max_tokens);
      const projected=(estimatedInputTokens*Number(model.input_price_per_million)+estimatedOutputTokens*Number(model.output_price_per_million))/1_000_000;
      const monthStart=new Date();monthStart.setDate(1);monthStart.setHours(0,0,0,0);
      const{data:monthRows}=await admin.from('platform_ai_usage_logs').select('estimated_cost').gte('created_at',monthStart.toISOString()).eq('succeeded',true);
      const spent=(monthRows??[]).reduce((sum,row)=>sum+Number(row.estimated_cost??0),0);
      if(spent+projected>Number(settings.monthly_budget))throw new Error('The request would exceed the configured monthly AI budget based on model pricing estimates.');
    }
    const start=Date.now(); let lastCategory='provider_error';
    for(let attempt=0;attempt<=provider.retry_limit;attempt++) {
      try {
        const result=await providerRequest(provider,model,key,content,Math.min(route.max_tokens,settings?.max_tokens_per_request??4096),taskPrompt,systemPrompt);
        const cost=model.input_price_per_million==null||model.output_price_per_million==null?null:(result.inputTokens*Number(model.input_price_per_million)+result.outputTokens*Number(model.output_price_per_million))/1_000_000;
        const {error:logError}=await admin.from('platform_ai_usage_logs').insert({request_id:requestId,feature_key:featureKey,provider_id:provider.id,model_id:model.id,fallback_index:index,input_tokens:result.inputTokens,output_tokens:result.outputTokens,estimated_cost:cost,latency_ms:Date.now()-start,succeeded:true});
        if(logError)console.error('AI usage success log failed',{requestId,code:logError.code});
        return result.parsed;
      } catch(error) {
        const e=error as Error&{category?:string};lastCategory=e.category??(e.name==='TimeoutError'?'timeout':'network');
        if(attempt>=provider.retry_limit||!temporary(lastCategory))break;
      }
    }
    await admin.from('platform_ai_usage_logs').insert({request_id:requestId,feature_key:featureKey,provider_id:provider.id,model_id:model.id,fallback_index:index,latency_ms:Date.now()-start,succeeded:false,error_category:lastCategory});
    if(!fallbackEligible(lastCategory))throw new Error(lastCategory==='authentication'?'AI provider authentication failed. Check the saved credential.':lastCategory==='quota'?'AI provider quota or credits are exhausted.':'AI provider rejected the configured model or request.');
  }
  throw new Error('No configured AI provider could complete this request. Check provider health, model approval, and image capability.');
}

export async function executeMenuExtraction(content:AiContent, mode:'text'|'image') {
  return executeConfiguredTextFeature('menu_extraction',content,mode);
}

export async function executeMenuTranslation(sourceLanguage:string,targetLanguage:string,items:unknown) {
  const taskPrompt=`Translate the provided restaurant menu text from ${sourceLanguage} to ${targetLanguage}. Return only JSON with the exact shape {"items":[{"id":"source-id","name":"translated name","description":"translated description or null"}],"categories":[{"id":"source-id","name":"translated name"}],"subcategories":[{"id":"source-id","name":"translated name"}],"variants":[{"id":"source-id","name":"translated name","description":"translated description or null"}],"modifierGroups":[{"id":"source-id","name":"translated name","description":"translated description or null"}],"modifiers":[{"id":"source-id","name":"translated name","description":"translated description or null"}]}. Preserve every supplied id exactly and include each record exactly once in its matching array. Translate names and descriptions faithfully; do not translate IDs, alter prices, infer ingredients, add claims, or omit uncertain text. Keep branded dish names recognizable. Input JSON:`;
  return executeConfiguredTextFeature('menu_translation',JSON.stringify(items),'text',taskPrompt,'You are a careful restaurant-menu translator. Return valid JSON only and never invent menu facts.','menu_extraction');
}
