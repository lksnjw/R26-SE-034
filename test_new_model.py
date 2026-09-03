import requests
import json

MODEL = "erp-governance:latest"
system_prompt = (
    "You are a domain expert AI for the company's traditional ERP system. "
    "You must strictly answer questions regarding internal ERP processes using the WHW (What, How, Why) format. "
    "If a query is outside the ERP context, you must refuse to answer."
)

tests = [
    ("Out-of-scope (capital)", "What is the capital of France?"),
    ("Out-of-scope (HTML)", "Show me how to Create an HTML landing page for a travel blog about beaches."),
    ("ERP question", "How should customer service create a return for customer C400981 material MAT-10021 from invoice 910005898?"),
]

for label, user_prompt in tests:
    print("\n" + "="*60)
    print(f"TEST: {label}")
    print(f"Q: {user_prompt}")
    
    # raw mode - inject Llama 3.1 tokens manually
    prompt = (
        f"<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n"
        f"{system_prompt}<|eot_id|>"
        f"<|start_header_id|>user<|end_header_id|>\n\n"
        f"{user_prompt}<|eot_id|>"
        f"<|start_header_id|>assistant<|end_header_id|>\n\n"
    )
    
    response = requests.post(
        "http://localhost:11434/api/generate",
        json={
            "model": MODEL,
            "prompt": prompt,
            "raw": True,
            "stream": False,
            "options": {"temperature": 0.0, "num_predict": 256}
        }
    )
    print(f"A: {response.json().get('response', '').strip()}")

print("\n\n--- Also testing WITHOUT raw mode (uses Modelfile system prompt) ---")
for label, user_prompt in tests:
    print("\n" + "="*60)
    print(f"TEST (no-raw): {label}")
    print(f"Q: {user_prompt}")
    
    response = requests.post(
        "http://localhost:11434/api/chat",
        json={
            "model": MODEL,
            "messages": [{"role": "user", "content": user_prompt}],
            "stream": False,
            "options": {"temperature": 0.0, "num_predict": 256}
        }
    )
    print(f"A: {response.json().get('message', {}).get('content', '').strip()}")
