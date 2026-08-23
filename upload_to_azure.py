"""
upload_to_azure.py - Automated Migration Script for Azure Cosmos DB & Azure Blob Storage
Uploads extracted PSAT questions with rewritten image URLs and concurrency/retry support.
"""

import os
import json
import argparse
import logging
import time
from typing import List, Dict, Any, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("azure_uploader")


def upload_questions_to_cosmos(
    cosmos_connection_str: Optional[str],
    database_name: str,
    container_name: str,
    questions_file: str,
    blob_base_url: Optional[str] = None,
    blob_container_name: str = "question-cards",
    dry_run: bool = False
):
    with open(questions_file, "r", encoding="utf-8") as f:
        questions = json.load(f)

    # Rewrite image paths to absolute Azure Blob Storage URLs
    if blob_base_url:
        base_url = blob_base_url.rstrip("/")
        for q in questions:
            if q.get("question_image"):
                filename = os.path.basename(q["question_image"])
                q["image_url"] = f"{base_url}/{blob_container_name}/{filename}"

    if dry_run:
        logger.info(f"[DRY-RUN] Prepared {len(questions)} items from '{questions_file}' for Cosmos DB container '{container_name}'.")
        if questions and "image_url" in questions[0]:
            logger.info(f"[DRY-RUN] Sample image_url: {questions[0]['image_url']}")
        return

    try:
        from azure.cosmos import CosmosClient, PartitionKey
        from azure.cosmos.exceptions import CosmosHttpResponseError
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

    logger.info(f"Uploading {len(questions)} items to Cosmos DB container '{container_name}'...")
    for idx, q in enumerate(questions):
        retries = 3
        while retries > 0:
            try:
                container.upsert_item(q)
                break
            except CosmosHttpResponseError as e:
                retries -= 1
                if retries == 0:
                    logger.error(f"Failed to upsert question {q.get('id')}: {str(e)}")
                else:
                    time.sleep(1.0)

        if (idx + 1) % 100 == 0 or idx == len(questions) - 1:
            logger.info(f"Uploaded {idx + 1} / {len(questions)} questions.")

    logger.info("Cosmos DB upload completed successfully.")


def _upload_single_blob(container_client, filepath: str, filename: str, overwrite: bool = True) -> bool:
    try:
        blob_client = container_client.get_blob_client(filename)
        with open(filepath, "rb") as data:
            blob_client.upload_blob(data, overwrite=overwrite)
        return True
    except Exception as e:
        logger.error(f"Failed to upload blob {filename}: {str(e)}")
        return False


def upload_images_to_blob(
    blob_connection_str: Optional[str],
    container_name: str,
    images_dir: str,
    max_workers: int = 16,
    public_access: bool = False,
    dry_run: bool = False
):
    image_files = [f for f in os.listdir(images_dir) if f.endswith((".png", ".webp", ".jpg"))]

    if dry_run:
        logger.info(f"[DRY-RUN] Found {len(image_files)} images in '{images_dir}' ready for upload to container '{container_name}'.")
        return

    try:
        from azure.storage.blob import BlobServiceClient
    except ImportError:
        logger.error("azure-storage-blob not installed. Install with: pip install azure-storage-blob")
        return

    logger.info(f"Connecting to Azure Blob Storage container '{container_name}'...")
    blob_service_client = BlobServiceClient.from_connection_string(blob_connection_str)
    container_client = blob_service_client.get_container_client(container_name)
    if not container_client.exists():
        container_client.create_container(public_access="blob" if public_access else None)

    logger.info(f"Uploading {len(image_files)} images using {max_workers} threads...")
    completed = 0
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(_upload_single_blob, container_client, os.path.join(images_dir, f), f): f
            for f in image_files
        }
        for future in as_completed(futures):
            if future.result():
                completed += 1
            if completed % 250 == 0 or completed == len(image_files):
                logger.info(f"Uploaded {completed} / {len(image_files)} images.")

    logger.info("Azure Blob Storage upload completed successfully.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Upload PSAT questions and assets to Azure.")
    parser.add_argument("--cosmos-conn", default=os.getenv("COSMOS_CONNECTION_STRING"), help="Azure Cosmos DB Connection String (or env COSMOS_CONNECTION_STRING)")
    parser.add_argument("--blob-conn", default=os.getenv("BLOB_CONNECTION_STRING"), help="Azure Blob Storage Connection String (or env BLOB_CONNECTION_STRING)")
    parser.add_argument("--blob-base-url", default=os.getenv("BLOB_BASE_URL"), help="Base URL of Azure Blob Storage (e.g. https://account.blob.core.windows.net)")
    parser.add_argument("--db-name", default="psat-prep-db", help="Cosmos DB Database Name")
    parser.add_argument("--container-name", default="Questions", help="Cosmos DB Container Name")
    parser.add_argument("--blob-container", default="question-cards", help="Blob Storage Container Name")
    parser.add_argument("--data-dir", default="data", help="Local directory containing questions and images")
    parser.add_argument("--public-access", action="store_true", help="Create public blob container (default: private)")
    parser.add_argument("--dry-run", action="store_true", help="Dry run without uploading")

    args = parser.parse_args()

    ela_file = os.path.join(args.data_dir, "ela_questions.json")
    math_file = os.path.join(args.data_dir, "math_questions.json")
    img_dir = os.path.join(args.data_dir, "images")

    if args.dry_run or args.cosmos_conn:
        if os.path.exists(ela_file):
            upload_questions_to_cosmos(args.cosmos_conn, args.db_name, args.container_name, ela_file, blob_base_url=args.blob_base_url, blob_container_name=args.blob_container, dry_run=args.dry_run)
        if os.path.exists(math_file):
            upload_questions_to_cosmos(args.cosmos_conn, args.db_name, args.container_name, math_file, blob_base_url=args.blob_base_url, blob_container_name=args.blob_container, dry_run=args.dry_run)

    if args.dry_run or args.blob_conn:
        if os.path.exists(img_dir):
            upload_images_to_blob(args.blob_conn, args.blob_container, img_dir, public_access=args.public_access, dry_run=args.dry_run)
