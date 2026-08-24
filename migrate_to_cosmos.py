"""
migrate_to_cosmos.py - Fast Parallel Question Bank & Schema Migration to Azure Cosmos DB
Creates 'Questions', 'UATStudentAnswers', and 'UATFeedback' containers and uploads all 3,059 questions.
"""

import os
import json
import logging
import time
from typing import List, Dict, Any, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed
from azure.cosmos import CosmosClient, PartitionKey
from azure.cosmos.exceptions import CosmosHttpResponseError

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("cosmos_migration")


def _upsert_single_question(container, q: Dict[str, Any]) -> bool:
    retries = 5
    backoff = 0.5
    while retries > 0:
        try:
            container.upsert_item(q)
            return True
        except CosmosHttpResponseError as e:
            if e.status_code in (429, 503):
                retries -= 1
                retry_after = (getattr(e, 'headers', None) or {}).get('x-ms-retry-after-ms')
                delay = (float(retry_after) / 1000.0) if retry_after else backoff
                time.sleep(delay)
                backoff *= 1.5
            else:
                logger.error(f"Cosmos error on {q.get('id')} ({e.status_code}): {str(e)}")
                return False
        except Exception as ex:
            logger.error(f"Error on {q.get('id')}: {str(ex)}")
            return False
    return False


def run_migration(cosmos_conn_str: str, blob_base_url: str, db_name: str = "psat-prep-db", blob_container_name: str = "question-cards"):
    logger.info(f"Connecting to Cosmos DB...")
    client = CosmosClient.from_connection_string(cosmos_conn_str)
    
    # 1. Create Database
    db = client.create_database_if_not_exists(id=db_name)
    logger.info(f"Database '{db_name}' ready.")

    # 2. Create Containers
    questions_container = db.create_container_if_not_exists(
        id="Questions",
        partition_key=PartitionKey(path="/domain")
    )
    logger.info("Container 'Questions' (PartitionKey: /domain) ready.")

    uat_answers_container = db.create_container_if_not_exists(
        id="UATStudentAnswers",
        partition_key=PartitionKey(path="/student_name")
    )
    logger.info("Container 'UATStudentAnswers' (PartitionKey: /student_name) ready.")

    uat_feedback_container = db.create_container_if_not_exists(
        id="UATFeedback",
        partition_key=PartitionKey(path="/category")
    )
    logger.info("Container 'UATFeedback' (PartitionKey: /category) ready.")

    # 3. Load Questions
    with open("data/ela_questions.json", "r", encoding="utf-8") as f:
        ela_qs = json.load(f)
    with open("data/math_questions.json", "r", encoding="utf-8") as f:
        math_qs = json.load(f)
    all_questions = ela_qs + math_qs
    logger.info(f"Loaded {len(all_questions)} questions ({len(ela_qs)} ELA, {len(math_qs)} Math).")

    # 4. Rewrite Image URLs
    base_url = blob_base_url.rstrip("/")
    for q in all_questions:
        if q.get("question_image"):
            filename = os.path.basename(q["question_image"])
            q["image_url"] = f"{base_url}/{blob_container_name}/{filename}"

    # 5. Upload Questions Concurrently
    logger.info(f"Uploading {len(all_questions)} questions to 'Questions' container using 16 threads...")
    t0 = time.time()
    succeeded = 0
    failed = 0

    with ThreadPoolExecutor(max_workers=16) as executor:
        futures = {executor.submit(_upsert_single_question, questions_container, q): q for q in all_questions}
        for future in as_completed(futures):
            if future.result():
                succeeded += 1
            else:
                failed += 1
            if (succeeded + failed) % 250 == 0 or (succeeded + failed) == len(all_questions):
                logger.info(f"Progress: {succeeded + failed} / {len(all_questions)} (Succeeded: {succeeded}, Failed: {failed})")

    logger.info(f"Cosmos DB Migration Complete in {time.time() - t0:.2f}s! Succeeded: {succeeded}, Failed: {failed}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Migrate questions to Azure Cosmos DB.")
    parser.add_argument("--cosmos-conn", default=os.getenv("COSMOS_CONNECTION_STRING"), required=True)
    parser.add_argument("--blob-base-url", default="https://psatprep4915.z13.web.core.windows.net", help="Base web/blob URL")
    args = parser.parse_args()

    run_migration(args.cosmos_conn, args.blob_base_url)
