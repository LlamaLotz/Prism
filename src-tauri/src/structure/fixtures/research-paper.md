Abstract

We evaluate whether a lightweight local language model can propose section boundaries for long documents. We compare two quantized models on a corpus of reports, transcripts, and web articles. The models receive block identifiers and return only section starts. Our deterministic validator derives section ends and rejects invalid coverage.

Introduction

Structured notes make retrieval and review easier. Converting extracted documents into sections is often manual. Large models are accurate but expensive and may send content off-device. Smaller local models are attractive when the task is constrained.

We focus on boundary selection rather than text rewriting. The model never receives write access to the document. We measure boundary agreement, heading quality, memory, and latency.

Methods

We parse each document into blocks with stable identifiers. Candidate boundaries are supplied as block summaries. The model returns an ordered list of section starts. We derive ends from the next start, so gaps and overlaps are impossible after normalization.

We compare four-bit quantizations under the same prompt and CPU budget. Each run uses two threads and an eight-thousand-token context. We repeat three times and report the median.

Results

The smallest model ran within one point one gigabytes of peak memory. It completed a twenty-block document in roughly two seconds after model load. Boundary agreement was high on documents with explicit headings and lower on unstructured transcripts.

Heading quality varied more than boundary quality. The model often copied a full sentence instead of producing a short label. We therefore validate headings and fall back to an extractive phrase when needed.

Discussion

The results support an optional local structure assistant rather than an autonomous formatter. Review remains necessary for transcripts and OCR text. Deterministic page and paragraph modes provide a reliable fallback.

Future work should expand the corpus and test fine-tuning for heading generation. Constrained decoding removes malformed JSON but does not guarantee semantic quality.
