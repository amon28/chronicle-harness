// What one model can do, from what the provider says about THAT model – not one switch for the whole provider, and never
// guessed from the model's name. Fields read (each only when present; otherwise the provider's own switches decide):
//   OpenRouter: architecture.input_modalities, supported_parameters, context_length, top_provider.{context_length,max_completion_tokens}
//   Mistral and others: capabilities.{vision,function_calling,completion_chat}
//   models.dev / OpenCode style: modalities.input, capabilities.tools.supported, capabilities.reasoning.supported, limit.{context,output}
//   generic: context_window, max_context_length, max_model_len, max_output_tokens
const num = (v) => (Number(v) > 0 ? Number(v) : 0);

/** → { tools, vision, reasoning, context, output } for a raw model entry m of provider p ({ tools, vision, context }). */
export function modelAbilities(m = {}, p = {}) {
  const params = Array.isArray(m.supported_parameters) ? m.supported_parameters.map(String) : null;
  const caps = m.capabilities && typeof m.capabilities === 'object' ? m.capabilities : {};
  const inMods = m.architecture?.input_modalities || m.modalities?.input || (typeof m.architecture?.modality === 'string' ? m.architecture.modality.split('->')[0].split('+') : null);

  let tools = p.tools !== false;
  if (params) tools = params.includes('tools');
  else if (typeof caps.function_calling === 'boolean') tools = caps.function_calling;
  else if (typeof caps.tools?.supported === 'boolean') tools = caps.tools.supported;
  else if (typeof caps.tool_call === 'boolean') tools = caps.tool_call;

  let vision = !!p.vision;
  if (Array.isArray(inMods)) vision = inMods.some((x) => /image/i.test(String(x)));
  else if (typeof caps.vision === 'boolean') vision = caps.vision;

  let reasoning = false;
  if (params) reasoning = params.includes('reasoning') || params.includes('include_reasoning');
  else if (typeof caps.reasoning?.supported === 'boolean') reasoning = caps.reasoning.supported;
  else if (typeof caps.reasoning === 'boolean') reasoning = caps.reasoning;

  const context = num(m.top_provider?.context_length) || num(m.context_length) || num(m.limit?.context) || num(m.context_window) || num(m.max_context_length) || num(m.max_model_len) || num(p.context) || 32768;
  const output = num(m.top_provider?.max_completion_tokens) || num(m.limit?.output) || num(m.max_output_tokens) || num(m.max_completion_tokens) || undefined;
  return { tools, vision, reasoning, context, output };
}
