"""
upload_to_azure.py - Automated Migration Script for Azure Cosmos DB & Azure Blob Storage
Uploads extracted PSAT questions to Cosmos DB and rendered images to Azure Blob Storage.
"""

import os
import json
import argparse
import logging
from typing import List, Dict, Any

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("azure_uploader")

def upload_questions_to_cosmos(
    cosmos_connection_str: str,
    database_name: str,
    container_name: str,
    questions_file: str
):
    try:
        from azure.cosmos import CosmosClient, PartitionKey
    except ImportError:
        logger.error("azure-cosmos not installed. Install with: pip install azure-cosmos")
        return

    logger.info(f"Connecting to Azure Cosmos DB database '{database_name}'...")
    client = CosmosClient.from_connection_string(cosmos_connection_str)
    db = client.create_database_if_not_exists(id=database_name)
    container = db.create_container_if_not_exists(
        id=container_name,
        partition_key=PartitionKey(path="/domain"),
        offer_throughput=None # Serverless mode
    )

    with open(questions_file, "r", encoding="utf-8") as f:
        questions = json.load(f)

    logger.info(f"Uploading {len(questions)} items to Cosmos DB container '{container_name}'...")
    for idx, q in enumerate(questions):
        container.upsert_item(q)
        if (idx + 1) % 100 == 0 or idx == len(questions) - 1:
            logger.info(f"Uploaded {idx + 1} / {len(questions)} questions.")

    logger.info("Cosmos DB upload completed successfully.")


def upload_images_to_blob(
    blob_connection_str: str,
    container_name: str,
    images_dir: str
):
    try:
        from azure.storage.blob import BlobServiceClient
    except ImportError:
        logger.error("azure-storage-blob not installed. Install with: pip install azure-storage-blob")
        return

    logger.info(f"Connecting to Azure Blob Storage container '{container_name}'...")
    blob_service_client = BlobServiceClient.from_connection_string(blob_connection_str)
    container_client = blob_service_client.get_container_client(container_name)
    if not container_client.exists():
        container_client.create_container(public_access="blob")

    image_files = [f for f in os.listdir(images_dir) if f.endswith((".png", ".webp", ".jpg"))]
    logger.info(f"Uploading {len(image_files)} rendered question card images to Blob Storage...")

    for idx, filename in enumerate(image_files):
        filepath = os.path.join(images_dir, filename)
        blob_client = container_client.get_blob_client(filename)
        with open(filepath, "rb") as data:
            blob_client.upload_blob(data, overwrite=True)
        if (idx + 1) % 100 == 0 or idx == len(image_files) - 1:
            logger.info(f"Uploaded {idx + 1} / {len(image_files)} images.")

    logger.info("Azure Blob Storage upload completed successfully.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Upload PSAT questions and assets to Azure.")
    parser.add_argument("--cosmos-conn", help="Azure Cosmos DB Connection String")
    parser.add_argument("--blob-conn", help="Azure Blob Storage Connection String")
    parser.add_argument("--db-name", default="psat-prep-db", help="Cosmos DB Database Name")
    parser.add_argument("--container-name", default="Questions", help="Cosmos DB Container Name")
    parser.add_argument("--blob-container", default="question-cards", help="Blob Storage Container Name")
    parser.add_argument("--data-dir", default="data", help="Local directory containing questions and images")

    args = parser.parse_args()

    if args.cosmos_conn:
        ela_file = os.path.join(args.data_dir, "ela_questions.json")
        math_file = os.path.join(args.data_dir, "math_questions.json")
        if os.path.exists(ela_file):
            upload_questions_to_cosmos(args.cosmos_conn, args.db_name, args.container_name, ela_file)
        if os.path.exists(math_file):
            upload_questions_to_cosmos(args.cosmos_conn, args.db_name, args.container_name, math_file)

    if args.blob_conn:
        img_dir = os.path.join(args.data_dir, "images")
        if os.path.exists(img_dir):
            upload_images_to_blob(args.blob_conn, args.blob_container, img_dir)
