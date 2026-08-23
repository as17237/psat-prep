"""
test_extractor.py - Comprehensive Unit Tests & Accuracy Validation for PSAT Extractor
"""

import unittest
import os
import json
from extractor import extract_questions_from_bank
from validator import validate_question, validate_dataset

class TestPSATExtractor(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.output_dir = "data"
        cls.images_dir = os.path.join(cls.output_dir, "images")
        os.makedirs(cls.images_dir, exist_ok=True)
        
        cls.ela_questions = extract_questions_from_bank(
            question_pdf_path="ELA1.pdf",
            answer_pdf_path="ELA1A.pdf",
            output_images_dir=cls.images_dir,
            limit=3,
            render_images=True
        )
        
        cls.math_questions = extract_questions_from_bank(
            question_pdf_path="MATH1.pdf",
            answer_pdf_path="MATH1A.pdf",
            output_images_dir=cls.images_dir,
            limit=3,
            render_images=True
        )

    def test_ela_extraction_count_and_validation(self):
        self.assertEqual(len(self.ela_questions), 3, "Expected 3 ELA questions")
        report = validate_dataset(self.ela_questions, base_image_dir=self.images_dir)
        self.assertTrue(report["is_valid"], f"Validation failed with errors: {report['errors_by_qid']}")
        self.assertEqual(report["valid_count"], 3)

    def test_math_extraction_count_and_validation(self):
        self.assertEqual(len(self.math_questions), 3, "Expected 3 Math questions")
        report = validate_dataset(self.math_questions, base_image_dir=self.images_dir)
        self.assertTrue(report["is_valid"], f"Validation failed with errors: {report['errors_by_qid']}")
        self.assertEqual(report["valid_count"], 3)

    def test_ela_question_1_ground_truth(self):
        q = self.ela_questions[0]
        self.assertEqual(q["id"], "737870c6")
        self.assertEqual(q["assessment"], "PSAT 8/9")
        self.assertEqual(q["test"], "Reading and Writing")
        self.assertEqual(q["domain"], "Information and Ideas")
        self.assertEqual(q["skill"], "Inferences")
        self.assertEqual(q["difficulty"], "Hard")
        self.assertEqual(q["type"], "multiple_choice")
        self.assertEqual(len(q["options"]), 4)
        self.assertEqual([opt["key"] for opt in q["options"]], ["A", "B", "C", "D"])
        self.assertEqual(q["correct_answer"], "C")
        self.assertTrue("Choice C is the best answer" in q["rationale"])
        self.assertTrue(os.path.exists(os.path.join(self.output_dir, q["question_image"])))

    def test_ela_question_2_ground_truth_multi_page(self):
        q = self.ela_questions[1]
        self.assertEqual(q["id"], "1b9fa866")
        self.assertEqual(q["assessment"], "PSAT 8/9")
        self.assertEqual(q["test"], "Reading and Writing")
        self.assertEqual(q["domain"], "Information and Ideas")
        self.assertEqual(q["skill"], "Command of Evidence")
        self.assertEqual(q["difficulty"], "Hard")
        self.assertEqual(q["type"], "multiple_choice")
        self.assertEqual(len(q["options"]), 4)
        self.assertEqual(q["correct_answer"], "A")
        self.assertTrue("Choice A is the best answer" in q["rationale"])
        self.assertTrue(os.path.exists(os.path.join(self.output_dir, q["question_image"])))

    def test_ela_question_3_ground_truth(self):
        q = self.ela_questions[2]
        self.assertEqual(q["id"], "da9a6075")
        self.assertEqual(q["assessment"], "PSAT 8/9")
        self.assertEqual(q["test"], "Reading and Writing")
        self.assertEqual(q["domain"], "Information and Ideas")
        self.assertEqual(q["skill"], "Command of Evidence")
        self.assertEqual(q["difficulty"], "Medium")
        self.assertEqual(q["type"], "multiple_choice")
        self.assertEqual(len(q["options"]), 4)
        self.assertEqual(q["correct_answer"], "A")
        self.assertTrue("Choice A is the best answer" in q["rationale"])
        self.assertTrue(os.path.exists(os.path.join(self.output_dir, q["question_image"])))

    def test_math_question_1_free_response(self):
        q = self.math_questions[0]
        self.assertEqual(q["id"], "6cdc66d9")
        self.assertEqual(q["assessment"], "PSAT 8/9")
        self.assertEqual(q["test"], "Math")
        self.assertEqual(q["domain"], "Algebra")
        self.assertEqual(q["skill"], "Linear functions")
        self.assertEqual(q["difficulty"], "Hard")
        self.assertEqual(q["type"], "free_response")
        self.assertEqual(len(q["options"]), 0)
        self.assertEqual(q["correct_answer"], "2")
        self.assertTrue("The correct answer is" in q["rationale"])
        self.assertTrue(os.path.exists(os.path.join(self.output_dir, q["question_image"])))

    def test_math_question_2_multiple_choice(self):
        q = self.math_questions[1]
        self.assertEqual(q["id"], "7326e8c1")
        self.assertEqual(q["assessment"], "PSAT 8/9")
        self.assertEqual(q["test"], "Math")
        self.assertEqual(q["domain"], "Algebra")
        self.assertEqual(q["skill"], "Linear functions")
        self.assertEqual(q["difficulty"], "Medium")
        self.assertEqual(q["type"], "multiple_choice")
        self.assertEqual(len(q["options"]), 4)
        self.assertEqual(q["correct_answer"], "A")
        self.assertTrue("Choice A is correct" in q["rationale"])
        self.assertTrue(os.path.exists(os.path.join(self.output_dir, q["question_image"])))

    def test_math_question_3_free_response(self):
        q = self.math_questions[2]
        self.assertEqual(q["id"], "b98324c9")
        self.assertEqual(q["assessment"], "PSAT 8/9")
        self.assertEqual(q["test"], "Math")
        self.assertEqual(q["domain"], "Algebra")
        self.assertEqual(q["skill"], "Linear equations in two variables")
        self.assertEqual(q["difficulty"], "Hard")
        self.assertEqual(q["type"], "free_response")
        self.assertEqual(len(q["options"]), 0)
        self.assertEqual(q["correct_answer"], "40")
        self.assertTrue("The correct answer is" in q["rationale"])
        self.assertTrue(os.path.exists(os.path.join(self.output_dir, q["question_image"])))

    def test_validator_detects_bad_data(self):
        # Corrupt data test
        bad_q = {
            "id": "bad123",
            "assessment": "PSAT 8/9",
            "test": "Math",
            "domain": "Algebra",
            "skill": "Linear functions",
            "difficulty": "Impossible", # invalid
            "type": "multiple_choice",
            "options": [{"key": "A", "text": "foo"}], # only 1 option
            "correct_answer": "Z", # invalid key
            "rationale": "short" # too short
        }
        errors = validate_question(bad_q)
        self.assertGreater(len(errors), 0, "Validator should flag multiple errors on corrupt question")

if __name__ == "__main__":
    unittest.main()
