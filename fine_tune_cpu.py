import torch
import os
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    TrainingArguments,
)
from peft import LoraConfig, get_peft_model
from trl import SFTTrainer
from datasets import load_dataset

model_name = "meta-llama/Meta-Llama-3.1-8B-Instruct"
dataset_path = "ft_data/erp_whw_1000_balanced.jsonl" 

max_seq_length = 512

print("Loading tokenizer...")
tokenizer = AutoTokenizer.from_pretrained(model_name)
tokenizer.pad_token = tokenizer.eos_token
tokenizer.padding_side = "right"

print("Loading model on CPU (This will take a lot of RAM)...")
model = AutoModelForCausalLM.from_pretrained(
    model_name,
    device_map="cpu", 
    torch_dtype=torch.float32,
    low_cpu_mem_usage=True
)

print("Applying PEFT/LoRA to reduce trainable parameters...")
model.gradient_checkpointing_enable()

peft_config = LoraConfig(
    r=8,
    lora_alpha=16,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    lora_dropout=0.05,
    bias="none",
    task_type="CAUSAL_LM",
)

model = get_peft_model(model, peft_config)
model.print_trainable_parameters()

print("Loading and formatting dataset...")
dataset = load_dataset("json", data_files=dataset_path, split="train")

def format_prompts(examples):
    formatted_texts = []
    for sys, usr, ast in zip(examples.get("system", []), examples.get("user", []), examples.get("assistant", [])):
        text = f"<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n{sys}<|eot_id|>"
        text += f"<|start_header_id|>user<|end_header_id|>\n\n{usr}<|eot_id|>"
        text += f"<|start_header_id|>assistant<|end_header_id|>\n\n{ast}<|eot_id|>"
        formatted_texts.append(text)
        
    return { "text" : formatted_texts }

dataset = dataset.map(format_prompts, batched=True)

print("Setting up Trainer...")
dataset_split = dataset.train_test_split(test_size=0.05, seed=42)
train_dataset = dataset_split["train"]
eval_dataset = dataset_split["test"]

training_args = TrainingArguments(
    output_dir="./results",
    per_device_train_batch_size=1,
    gradient_accumulation_steps=8,
    learning_rate=2e-4,
    logging_steps=1,
    max_steps=50, 
    evaluation_strategy="steps",
    eval_steps=10,
    save_strategy="steps",
    save_steps=10,
    optim="adamw_torch",
    report_to="none",
    fp16=False,
    bf16=False,
    use_cpu=True
)

trainer = SFTTrainer(
    model=model,
    train_dataset=train_dataset,
    eval_dataset=eval_dataset,
    dataset_text_field="text",
    max_seq_length=max_seq_length,
    tokenizer=tokenizer,
    args=training_args,
)

print("Starting training...")
trainer.train()

model.save_pretrained("local_cpu_lora_model")
tokenizer.save_pretrained("local_cpu_lora_model")
print("Training complete and LoRA model saved!")

eval_results = trainer.evaluate()
print(f"Evaluation Results: {eval_results}")

test_prompt = eval_dataset[0]['text'].split("<|start_header_id|>assistant<|end_header_id|>\n\n")[0] + "<|start_header_id|>assistant<|end_header_id|>\n\n"
inputs = tokenizer(test_prompt, return_tensors="pt").to("cpu")

model.eval()
with torch.no_grad():
    outputs = model.generate(**inputs, max_new_tokens=50, pad_token_id=tokenizer.eos_token_id)
    
print("\n--- Test Generation ---")
print(tokenizer.decode(outputs[0], skip_special_tokens=True))
