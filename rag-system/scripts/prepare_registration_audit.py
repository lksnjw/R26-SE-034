"""Create the separate payload-only audit collection before hosted deployment."""
from src.config.qdrant_client import get_qdrant_client
from src.config.settings import settings


def main():
    name = settings.REGISTRATION_AUDIT_COLLECTION
    if name in {settings.POLICY_COLLECTION, settings.QDRANT_COLLECTION}:
        raise ValueError("Audit records require a separate collection")
    client = get_qdrant_client()
    if not client.collection_exists(name):
        client.create_collection(collection_name=name, vectors_config={})
        print(f"Created payload-only audit collection: {name}")
    if client.get_collection(name).config.params.vectors != {}:
        raise ValueError("Audit collection must be payload-only; existing data was not changed")
    print(f"Audit collection ready: {name}")


if __name__ == "__main__":
    main()
