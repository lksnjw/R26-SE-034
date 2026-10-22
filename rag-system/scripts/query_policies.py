"""Inspect registration retrieval: python -m scripts.query_policies phone"""
import argparse

from src.core.registration.retriever import RegistrationRetriever


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("field", nargs="?")
    args = parser.parse_args()
    chunks = RegistrationRetriever().retrieve(field=args.field, query=f"employee registration {args.field or 'complete form'} policy")
    for chunk in chunks:
        meta = chunk["metadata"]
        print(f"{meta['policy_id']} | {meta['section']} | {','.join(meta['field'])}")
    print(f"Retrieved {len(chunks)} sections.")


if __name__ == "__main__":
    main()
