"""
test_extractor.py - Unit and Integration Test Suite for PSAT Extraction Engine
Runs fast, deterministic parser tests on committed fixtures without requiring raw PDF files.
"""

import unittest
import os
from extractor import parse_question_text, parse_choices_robust
from validator import validate_question, validate_dataset

FIXTURES_DIR = os.path.join(os.path.dirname(__file__), "tests", "fixtures")

def load_fixture(filename: str) -> str:
    path = os.path.join(FIXTURES_DIR, filename)
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


class TestExtractorParser(unittest.TestCase):
    """
    Pure parser unit tests executing against committed text fixtures.
    Runs on any machine in milliseconds with zero dependencies on large source PDFs.
    """

    def test_parse_ela_question(self):
        txt = load_fixture("ela_sample.txt")
        q = parse_question_text(txt, "737870c6")
        
        self.assertEqual(q["id"], "737870c6")
        self.assertEqual(q["assessment"], "PSAT 8/9")
        self.assertEqual(q["test"], "Reading and Writing")
        self.assertEqual(q["domain"], "Information and Ideas")
        self.assertEqual(q["skill"], "Inferences")
        self.assertEqual(q["difficulty"], "Hard")
        self.assertEqual(q["type"], "multiple_choice")
        self.assertEqual(q["correct_answer"], "C")
        self.assertEqual(len(q["options"]), 4)
        self.assertTrue(q["text_complete"])
        
        errs, warns = validate_question(q)
        self.assertEqual(errs, [])

    def test_parse_math_mc_question(self):
        txt = load_fixture("math_mc_sample.txt")
        q = parse_question_text(txt, "6cdc66d9")
        
        self.assertEqual(q["id"], "6cdc66d9")
        self.assertEqual(q["test"], "Math")
        self.assertEqual(q["domain"], "Algebra")
        self.assertEqual(q["skill"], "Linear functions")
        self.assertEqual(q["difficulty"], "Hard")
        self.assertEqual(q["type"], "multiple_choice")
        self.assertEqual(q["correct_answer"], "D")
        self.assertEqual(len(q["options"]), 4)
        self.assertTrue(q["text_complete"])
        
        errs, warns = validate_question(q)
        self.assertEqual(errs, [])

    def test_parse_math_vector_placeholder(self):
        txt = load_fixture("math_vector_sample.txt")
        q = parse_question_text(txt, "0cb26bb3")
        
        self.assertEqual(q["id"], "0cb26bb3")
        self.assertEqual(q["type"], "multiple_choice")
        self.assertEqual(q["correct_answer"], "A")
        self.assertEqual(len(q["options"]), 4)
        # Vector formulas in options are detected as not text_complete
        self.assertFalse(q["text_complete"])
        
        errs, warns = validate_question(q)
        self.assertEqual(errs, [])
        self.assertTrue(any("placeholder" in w for w in warns))

    def test_parse_free_response(self):
        txt = load_fixture("math_fr_sample.txt")
        q = parse_question_text(txt, "c03ee93c")
        
        self.assertEqual(q["id"], "c03ee93c")
        self.assertEqual(q["type"], "free_response")
        self.assertEqual(q["correct_answer"], "14")
        self.assertEqual(len(q["options"]), 0)
        self.assertTrue(q["text_complete"])
        
        errs, warns = validate_question(q)
        self.assertEqual(errs, [])

    def test_parse_numbered_options(self):
        txt = load_fixture("num_options_sample.txt")
        q = parse_question_text(txt, "fb17d540")
        
        self.assertEqual(q["id"], "fb17d540")
        self.assertEqual(q["type"], "multiple_choice")
        self.assertEqual(q["correct_answer"], "B")
        self.assertEqual(len(q["options"]), 4)
        self.assertEqual([opt["key"] for opt in q["options"]], ["A", "B", "C", "D"])
        self.assertEqual(q["options"][1]["text"], "comparable to")
        
        errs, warns = validate_question(q)
        self.assertEqual(errs, [])

    def test_parse_note_that_answer_fallback(self):
        txt = load_fixture("note_that_sample.txt")
        q = parse_question_text(txt, "c133370d")
        
        self.assertEqual(q["id"], "c133370d")
        self.assertEqual(q["type"], "free_response")
        self.assertEqual(q["correct_answer"], "5/2")
        
        errs, warns = validate_question(q)
        self.assertEqual(errs, [])

    def test_validator_catches_invalid_difficulty(self):
        q = {
            "id": "bad123",
            "assessment": "PSAT 8/9",
            "test": "Math",
            "domain": "Algebra",
            "skill": "Linear equations",
            "difficulty": "SuperHard",
            "type": "free_response",
            "question_text": "Solve for x.",
            "options": [],
            "correct_answer": "5",
            "rationale": "The correct answer is 5."
        }
        errs, _ = validate_question(q)
        self.assertTrue(any("Invalid difficulty" in e for e in errs))


class TestPDFIntegration(unittest.TestCase):
    """
    Integration tests requiring raw PDF files.
    Skipped cleanly in CI or fresh checkouts where PDFs are not present.
    """

    @unittest.skipUnless(os.path.exists("ELA1.pdf") and os.path.exists("ELA1A.pdf"), "ELA PDFs not present")
    def test_pdf_ela_sample_extraction(self):
        from extractor import extract_questions_from_bank
        extracted = extract_questions_from_bank("ELA1.pdf", "ELA1A.pdf", limit=3, render_images=False)
        self.assertEqual(len(extracted), 3)

    @unittest.skipUnless(os.path.exists("MATH1.pdf") and os.path.exists("MATH1A.pdf"), "Math PDFs not present")
    def test_pdf_math_sample_extraction(self):
        from extractor import extract_questions_from_bank
        extracted = extract_questions_from_bank("MATH1.pdf", "MATH1A.pdf", limit=3, render_images=False)
        self.assertEqual(len(extracted), 3)


if __name__ == "__main__":
    unittest.main()
