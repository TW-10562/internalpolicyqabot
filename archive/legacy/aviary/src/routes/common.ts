import Router from "@koa/router";
import fs from "fs";
import path from "path";
import { config } from "../config";

const router = new Router({ prefix: "/common" });

function ensureDir(dir: string) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function normalizeFile(file: any) {
    if (!file) return null;
    if (Array.isArray(file)) return file[0];
    return file;
}

router.post("/image", async (ctx) => {
    const files = (ctx.request as any).files as Record<string, any> | undefined;
    const file = normalizeFile(files?.file || files?.image);
    if (!file) {
        ctx.status = 400;
        ctx.body = { code: 400, msg: "未找到文件" };
        return;
    }
    ensureDir(config.uploadDir);
    const filename = path.basename(file.filepath || file.path || file.name);
    const url = `/${filename}`;
    ctx.body = { code: 200, msg: "上传成功", data: { filename, url } };
});

router.post("/files", async (ctx) => {
    const files = (ctx.request as any).files as Record<string, any> | undefined;
    if (!files) {
        ctx.status = 400;
        ctx.body = { code: 400, msg: "未找到文件" };
        return;
    }
    ensureDir(config.uploadDir);
    const list: { filename: string; url: string }[] = [];
    Object.values(files).forEach((value) => {
        const file = normalizeFile(value);
        if (file) {
            const filename = path.basename(file.filepath || file.path || file.name);
            list.push({ filename, url: `/${filename}` });
        }
    });
    ctx.body = { code: 200, msg: "上传成功", data: list };
});

router.post("/delImage", async (ctx) => {
    const { filename } = (ctx.request as any).body as { filename?: string };
    if (!filename) {
        ctx.status = 400;
        ctx.body = { code: 400, msg: "缺少文件名" };
        return;
    }
    const target = path.join(config.uploadDir, filename);
    if (fs.existsSync(target)) {
        await fs.promises.unlink(target);
    }
    ctx.body = { code: 200, msg: "删除成功" };
});

const commonRouter: Router = router;
export default commonRouter;
