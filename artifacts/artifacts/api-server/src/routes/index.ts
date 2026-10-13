import { Router, type IRouter } from "express";
import a2aRouter from "./a2a";
import healthRouter from "./health";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/a2a", a2aRouter);

export default router;
