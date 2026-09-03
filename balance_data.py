# import json
# from collections import defaultdict
# import random

# dataset_path = "ft_data/erp_whw_10000.jsonl"
# out_path = "ft_data/erp_whw_1000_balanced.jsonl"

# data = []
# with open(dataset_path, 'r', encoding='utf-8') as f:
#     for line in f:
#         if line.strip():
#             data.append(json.loads(line))

# # Let's see what keys are in the first item
# print("Keys in data:", data[0].keys())
# print("First item user:", data[0].get('user', ''))

# # We need to find a way to group these to balance them.
# # Usually, we can group by the first few words of the instruction or an explicit category field if it exists.
# groups = defaultdict(list)
# for item in data:
#     user_text = item.get('user', '')
#     if ':' in user_text:
#         group_key = user_text.split(':')[0]
#     else:
#         group_key = " ".join(user_text.split()[:4])
#     groups[group_key].append(item)

# print(f"Total records: {len(data)}")
# print(f"Number of inferred groups: {len(groups)}")

# # Stratified sampling
# sample_size = 1000
# sampled_data = []

# # If there are fewer groups than sample size, we sample proportionally
# if len(groups) > 0:
#     for k, v in groups.items():
#         # proportion
#         prop = len(v) / len(data)
#         num_to_sample = int(round(prop * sample_size))
        
#         # ensure at least 1 if possible
#         if num_to_sample == 0 and len(v) > 0 and len(sampled_data) < sample_size:
#             num_to_sample = 1
            
#         sampled_data.extend(random.sample(v, min(num_to_sample, len(v))))

# # Adjust if we are slightly off due to rounding
# if len(sampled_data) > sample_size:
#     sampled_data = random.sample(sampled_data, sample_size)
# elif len(sampled_data) < sample_size:
#     # grab more randomly from the remaining
#     needed = sample_size - len(sampled_data)
#     remaining = [d for d in data if d not in sampled_data]
#     sampled_data.extend(random.sample(remaining, min(needed, len(remaining))))

# random.shuffle(sampled_data)

# with open(out_path, 'w', encoding='utf-8') as f:
#     for item in sampled_data:
#         f.write(json.dumps(item, ensure_ascii=False) + '\n')

# print(f"Saved {len(sampled_data)} balanced records to {out_path}")
