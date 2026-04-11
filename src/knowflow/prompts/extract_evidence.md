# Task: Extract Evidence

You are a knowledge extraction assistant. Given the context (topic and source text), extract factual claims and relations.

## Context
Topic: {{topic}}
Source URL: {{url}}
Title: {{title}}

## Source Text
{{text}}

## Instructions
1. Extract atomic factual claims about the topic from the source text.
2. For each claim, assign a confidence score (0.0 to 1.0) based on how clearly it is stated.
3. Identify relations between the current topic and other topics mentioned.
4. Return the result in the following JSON format:
{{output_hint}}
