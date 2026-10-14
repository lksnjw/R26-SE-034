const response = await fetch(`${process.env.GENERATION_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
  method: "POST", headers: {Authorization: `Bearer ${process.env.GENERATION_API_KEY}`, "Content-Type": "application/json"},
  body: JSON.stringify({model: process.env.GENERATION_MODEL_PRIMARY, messages: [{role: "user", content: "Reply with OK."}], max_tokens: 32}),
  signal: AbortSignal.timeout(30000), redirect: "error",
});
const result = await response.json();
console.log(JSON.stringify({status: response.status, code: result.error?.code,
  message: result.error?.message?.slice(0, 180), model: result.model, answer: result.choices?.[0]?.message?.content}));
