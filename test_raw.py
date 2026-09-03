import requests

MODEL = "my-finance-model:latest"
system_prompt = "You are a domain expert AI for the company's traditional ERP system. You must strictly answer questions regarding internal ERP processes using the WHW (What, How, Why) format. If a query is outside the ERP context, you must refuse to answer."

tests = [
    ("ERP question", "How should customer service create a return for customer C400981 material MAT-10021 from invoice 910005898?"),
    ("Out-of-scope", "What is the capital of France?"),
]

for label, user_prompt in tests:
    print(f"\n{'='*60}")
    print(f"TEST: {label}")
    print(f"Q: {user_prompt}")
    prompt = f"<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n{system_prompt}<|eot_id|><|start_header_id|>user<|end_header_id|>\n\n{user_prompt}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n"
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
