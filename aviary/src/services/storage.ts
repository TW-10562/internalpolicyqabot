import { StorageFactory, type StorageProvider } from "@aviary-ai/infra-storage";
import { config } from "../config/index";

let storageProvider: StorageProvider | null = null;

export function getStorageProvider(): StorageProvider {
    if (!storageProvider) {
        storageProvider = StorageFactory.create(config.storage as any);
    }

    return storageProvider!;
}

export async function uploadAvatar(userId: string | number, imageBase64: string): Promise<string> {
    const storage = getStorageProvider();

    const buffer = Buffer.from(imageBase64, "base64");

    const filename = `avatar_${userId}.png`;

    await storage.upload(filename, buffer, {
        contentType: "image/png",
        cacheControl: "public, max-age=31536000",
    });

    return filename;
}

export async function downloadAvatar(userId: string | number, filename: string): Promise<Buffer> {
    const storage = getStorageProvider();

    return await storage.download(filename);
}
