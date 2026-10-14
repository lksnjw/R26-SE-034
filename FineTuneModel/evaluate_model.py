import json
import os
import requests
import pandas as pd
from rouge_score import rouge_scorer
import re
import time
import argparse

REFUSAL_KEYWORDS = [
    "action blocked", "non-erp", "out of scope", "outside the scope",
    "cannot answer", "cannot assist", "cannot help", "i cannot", "i am unable",
    "not related to erp", "not an erp", "unrelated to erp", "refuse",
    "not permitted", "outside my scope", "traditional erp system",
    "only answer questions regarding"
]

def check_semantic_refusal(text: str) -> bool:
    """Checks if the response indicates a refusal for out-of-scope questions."""
    lower = text.lower()
    return any(kw in lower for kw in REFUSAL_KEYWORDS)

def evaluate_model(
    model_name="my-finance-model:latest",
    data_path=None,
    num_samples=50,
    standard_threshold=0.35,
    strict_threshold=0.50,
    output_file="evaluation_results.csv"
):
    # Auto-detect best dataset path if not specified
    if not data_path:
        for candidate in ["ft_data/erp_eval_realistic_50.jsonl", "ft_data/erp_eval_50.jsonl", "ft_data/erp_whw_1000_balanced.jsonl"]:
            if os.path.exists(candidate):
                data_path = candidate
                break

    if not data_path or not os.path.exists(data_path):
        print(f"Error: Dataset file '{data_path}' not found.", flush=True)
        return

    print(f"Starting content-based evaluation of model: {model_name}", flush=True)
    print(f"Using data from: {data_path} (evaluating first {num_samples} samples)", flush=True)
    print(f"Thresholds -> Standard: ROUGE-L >= {standard_threshold:.2f} | Strict: ROUGE-L >= {strict_threshold:.2f}", flush=True)
    
    # Load data
    data = []
    with open(data_path, 'r', encoding='utf-8') as f:
        for line in f:
            if line.strip():
                data.append(json.loads(line))
            
    eval_data = data[:num_samples] if len(data) > num_samples else data

    scorer = rouge_scorer.RougeScorer(['rouge1', 'rouge2', 'rougeL'], use_stemmer=True)
    results = []

    for i, item in enumerate(eval_data):
        system_prompt = item.get("system", "")
        user_prompt = item.get("user", "")
        reference_answer = item.get("assistant", "")
        
        is_out_of_scope = "ACTION BLOCKED" in reference_answer
        
        prompt = f"<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n{system_prompt}<|eot_id|><|start_header_id|>user<|end_header_id|>\n\n{user_prompt}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n"
        
        print(f"[{i+1}/{len(eval_data)}] Evaluating prompt: {user_prompt[:50]}...", flush=True)
        
        start_time = time.time()
        try:
            response = requests.post(
                "http://localhost:11434/api/generate",
                json={
                    "model": model_name,
                    "prompt": prompt,
                    "raw": True,
                    "stream": False,
                    "options": {
                        "temperature": 0.0,
                        "num_predict": 256
                    }
                }
            )
            response.raise_for_status()
            generated_text = response.json().get("response", "").strip()
        except Exception as e:
            print(f"Error querying model: {e}")
            generated_text = ""
            
        latency = time.time() - start_time
        
        # Content-based ROUGE scoring against reference answer
        scores = scorer.score(reference_answer, generated_text)
        r1 = scores['rouge1'].fmeasure
        r2 = scores['rouge2'].fmeasure
        rl = scores['rougeL'].fmeasure
        
        # Tiered Content Correctness
        if is_out_of_scope:
            refusal_detected = check_semantic_refusal(generated_text)
            standard_correct = refusal_detected
            strict_correct = refusal_detected
        else:
            refusal_detected = False
            standard_correct = (rl >= standard_threshold)
            strict_correct = (rl >= strict_threshold)
                
        results.append({
            "User Prompt": user_prompt,
            "Reference": reference_answer,
            "Generated": generated_text,
            "Is Out of Scope": is_out_of_scope,
            "Standard Correct": standard_correct,
            "Strict Correct": strict_correct,
            "ROUGE-1": round(r1, 4),
            "ROUGE-2": round(r2, 4),
            "ROUGE-L": round(rl, 4),
            "Refusal Detected": refusal_detected,
            "Latency (s)": round(latency, 2)
        })

    df = pd.DataFrame(results)
    df.to_csv(output_file, index=False)
    
    in_scope_df = df[~df["Is Out of Scope"]]
    out_scope_df = df[df["Is Out of Scope"]]
    
    std_overall_acc = df["Standard Correct"].mean() * 100
    strict_overall_acc = df["Strict Correct"].mean() * 100
    
    std_in_scope_acc = in_scope_df["Standard Correct"].mean() * 100 if len(in_scope_df) > 0 else 0.0
    strict_in_scope_acc = in_scope_df["Strict Correct"].mean() * 100 if len(in_scope_df) > 0 else 0.0
    out_scope_acc = out_scope_df["Standard Correct"].mean() * 100 if len(out_scope_df) > 0 else 0.0
    
    avg_r1 = df["ROUGE-1"].mean()
    avg_r2 = df["ROUGE-2"].mean()
    avg_rl = df["ROUGE-L"].mean()
    avg_latency = df["Latency (s)"].mean()
    
    print("\n" + "="*56)
    print("         ERP CONTENT EVALUATION SUMMARY")
    print("="*56)
    print(f"Total Samples Evaluated        : {len(df)}")
    print(f"  - In-Scope ERP Tasks         : {len(in_scope_df)}")
    print(f"  - Out-of-Scope / Non-ERP     : {len(out_scope_df)}")
    print("-" * 56)
    print(f"Continuous Metrics:")
    print(f"  Average Content ROUGE-1 Score: {avg_r1:.4f}")
    print(f"  Average Content ROUGE-2 Score: {avg_r2:.4f}")
    print(f"  Average Content ROUGE-L Score: {avg_rl:.4f}")
    print("-" * 56)
    print(f"Accuracy Breakdown:")
    print(f"  Standard Accuracy (ROUGE-L >= {standard_threshold:.2f}): {std_overall_acc:.2f}%  (In-scope: {std_in_scope_acc:.2f}%)")
    print(f"  Strict Accuracy   (ROUGE-L >= {strict_threshold:.2f}): {strict_overall_acc:.2f}%  (In-scope: {strict_in_scope_acc:.2f}%)")
    print(f"  Out-of-Scope Refusal Rate   : {out_scope_acc:.2f}%")
    print("-" * 56)
    print(f"Average Latency per request    : {avg_latency:.2f}s")
    print("="*56)
    print(f"Detailed per-sample results saved to '{output_file}'")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Evaluate model on ERP domain content.")
    parser.add_argument("--model", type=str, default="my-finance-model:latest", help="Ollama model name")
    parser.add_argument("--samples", type=int, default=50, help="Number of samples to evaluate")
    parser.add_argument("--data", type=str, default=None, help="Path to jsonl dataset (default: auto-detect)")
    parser.add_argument("--standard-threshold", type=float, default=0.35, help="Standard ROUGE-L threshold")
    parser.add_argument("--strict-threshold", type=float, default=0.50, help="Strict ROUGE-L threshold")
    parser.add_argument("--output", type=str, default="evaluation_results.csv", help="Output CSV file path")
    args = parser.parse_args()
    
    evaluate_model(args.model, args.data, args.samples, args.standard_threshold, args.strict_threshold, args.output)


