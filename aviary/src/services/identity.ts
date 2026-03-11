import {
    BcryptPasswordHasher,
    JwtTokenService,
    RedisCaptchaStore,
    RedisSessionStore,
} from "@aviary-ai/identity-access";
import { MySQLIdentityAdapter } from "@aviary-ai/identity-access-mysql";
import { config } from "../config/index";
import { sequelize } from "../database/index";
import redis from "../redis/index";
import * as storage from "./storage";

const tokenService = new JwtTokenService(config.jwt.secret);
const sessionStore = new RedisSessionStore(redis);
const captchaStore = new RedisCaptchaStore(redis);
const passwordHasher = new BcryptPasswordHasher(10);

const adapter = new MySQLIdentityAdapter({
    sequelize,
    storageAdapter: {
        async uploadAvatar(userId, imageBase64) {
            return await storage.uploadAvatar(userId, imageBase64);
        },
        async downloadAvatar(userId, filename) {
            return await storage.downloadAvatar(userId, filename);
        },
    },
});

export const identityDeps = {
    adapter,
    passwordHasher,
    tokenService,
    sessionStore,
    captchaStore,
    requireCaptcha: true,
};
