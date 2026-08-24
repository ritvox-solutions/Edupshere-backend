import { Request, Response } from "express";
import { healthService } from "../services/health.service";

export const healthController = {
  async check(_req: Request, res: Response): Promise<void> {
    const result = await healthService.check();
    res.status(200).json(result);
  },
};
