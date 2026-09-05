import { Router } from "express";
import {
  createDecision,
  getDecisions,
  getDecisionById,
} from "../controllers/decisionController.js";
import { auth } from "../middleware/auth.js";

const router = Router();

router.post("/", auth, createDecision);
router.get("/", auth, getDecisions);
router.get("/:id", auth, getDecisionById);

export default router;
