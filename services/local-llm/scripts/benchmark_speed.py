#!/usr/bin/env python3
"""
MLX推論速度ベンチマーク
"""
import time
from mlx_lm import load, generate
from mlx_lm.sample_utils import make_sampler

def benchmark_inference():
    print("Loading model...")
    model, tokenizer = load("mlx-community/gemma-4-e4b-it-4bit")
    
    prompt = "東京の天気について教えてください。"
    formatted = tokenizer.apply_chat_template(
        [{"role": "user", "content": prompt}],
        add_generation_prompt=True,
        tokenize=False
    )
    
    print("\nBenchmarking inference speed...")
    tokens_generated = 0
    start_time = time.time()
    
    for chunk in generate(model, tokenizer, prompt=formatted, sampler=make_sampler(0.0), max_tokens=100):
        tokens_generated += 1
    
    elapsed = time.time() - start_time
    tokens_per_sec = tokens_generated / elapsed
    
    print(f"\n=== Results ===")
    print(f"Tokens generated: {tokens_generated}")
    print(f"Time elapsed: {elapsed:.2f}s")
    print(f"Tokens/sec: {tokens_per_sec:.2f}")
    print(f"Time per token: {(elapsed/tokens_generated)*1000:.2f}ms")

if __name__ == "__main__":
    benchmark_inference()
