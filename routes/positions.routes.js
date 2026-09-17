import { Router } from "express";
import { auth } from "../middleware/auth.js";
import {
  createPosition,
  addAction,
  getPositions,
  getPositionById,
  softDeletePosition,
} from "../controllers/positionsController.js";

const router = Router();

// Każda trasa pozycji wymaga JWT — req.userId z middleware/auth.js
router.use(auth);

router.post("/", createPosition);
router.get("/", getPositions);
router.get("/:id", getPositionById);
router.post("/:id/actions", addAction);
router.delete("/:id", softDeletePosition);

export default router;
