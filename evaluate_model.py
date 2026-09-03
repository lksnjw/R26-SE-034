import json
import requests
import pandas as pd
from rouge_score import rouge_scorer
import re
import time
import argparse

def evaluate_model(model_name="my-finance-model:latest", data_path="ft_data/erp_whw_1000_balanced.jsonl", num_samples=50, output_file="evaluation_results.csv"):
    print(f"Starting evaluation of model: {model_name}", flush=True)
    print(f"Using data from: {data_path} (evaluating first {num_samples} samples)", flush=True)
    
    # Load data
    data = []
    with open(data_path, 'r', encoding='utf-8') as f:
        for line in f:
            data.append(json.loads(line))
            
    # Take a subset
    if len(data) > num_samples:
        eval_data = data[:num_samples]
    else:
        eval_data = data

    scorer = rouge_scorer.RougeScorer(['rougeL'], use_stemmer=True)
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
        
        format_correct = False
        if is_out_of_scope:
            if "ACTION BLOCKED" in generated_text and "NON-ERP_CONTEXT" in generated_text:
                format_correct = True
        else:
            if "WHAT:" in generated_text and "HOW:" in generated_text and "WHY:" in generated_text:
                format_correct = True
                
        scores = scorer.score(reference_answer, generated_text)
        rouge_l_fmeasure = scores['rougeL'].fmeasure
        
        results.append({
            "User Prompt": user_prompt,
            "Reference": reference_answer,
            "Generated": generated_text,
            "Is Out of Scope": is_out_of_scope,
            "Format Correct": format_correct,
            "ROUGE-L": rouge_l_fmeasure,
            "Latency (s)": round(latency, 2)
        })

    df = pd.DataFrame(results)
    df.to_csv(output_file, index=False)
    
    format_accuracy = df["Format Correct"].mean() * 100
    avg_rouge = df["ROUGE-L"].mean()
    avg_latency = df["Latency (s)"].mean()
    
    print("\n" + "="*40)
    print("EVALUATION SUMMARY")
    print("="*40)
    print(f"Total Samples Evaluated: {len(df)}")
    print(f"Format Adherence Accuracy: {format_accuracy:.2f}%")
    print(f"Average ROUGE-L Score: {avg_rouge:.4f}")
    print(f"Average Latency per request: {avg_latency:.2f}s")
    print("="*40)
    print(f"Detailed results saved to '{output_file}'")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=str, default="my-finance-model:latest", help="Ollama model name")
    parser.add_argument("--samples", type=int, default=50, help="Number of samples to evaluate")
    parser.add_argument("--data", type=str, default="ft_data/erp_whw_1000_balanced.jsonl", help="Path to jsonl dataset")
    parser.add_argument("--output", type=str, default="evaluation_results.csv", help="Output CSV file path")
    args = parser.parse_args()
    
    evaluate_model(args.model, args.data, args.samples, args.output)
