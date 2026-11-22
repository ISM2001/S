import { prisma } from "@tiqa/db";
import { runTrustJob } from "./trust";

console.log("trust job", await runTrustJob(prisma));
await prisma.$disconnect();
