import { Router } from "express";
import {
  createDecision,
  getDecisions,
  getDecisionById,
} from "../controllers/decisionController.js";

const router = Router();

router.post("/", createDecision);
router.get("/", getDecisions);
router.get("/:id", getDecisionById);

export default router;
