const { PrismaClient } = require('@prisma/client');
const c = new PrismaClient();
console.log(typeof c.$use);
console.log(Object.getOwnPropertyNames(Object.getPrototypeOf(c)));
