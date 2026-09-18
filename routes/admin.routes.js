import { Router } from "express";
import { auth } from "../middleware/auth.js";
import { adminOnly } from "../middleware/adminOnly.js";
import { getUsage } from "../controllers/adminController.js";

const router = Router();

router.get("/usage", auth, adminOnly, getUsage);

export default router;
