export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message?: string,
    public details?: unknown,
  ) {
    super(message ?? code);
  }
}

export const badRequest = (code: string, details?: unknown) => new ApiError(400, code, code, details);
export const unauthorized = (code = "UNAUTHORIZED") => new ApiError(401, code);
export const forbidden = (code = "FORBIDDEN") => new ApiError(403, code);
export const notFound = (code = "NOT_FOUND") => new ApiError(404, code);
export const tooMany = (code: string, details?: unknown) => new ApiError(429, code, code, details);
