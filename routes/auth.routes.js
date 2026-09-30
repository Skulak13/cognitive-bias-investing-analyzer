import { Router } from "express";
import {
  register,
  login,
  acceptDisclaimer,
} from "../controllers/authController.js";
import { auth } from "../middleware/auth.js";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.post("/accept-disclaimer", auth, acceptDisclaimer);

export default router;
