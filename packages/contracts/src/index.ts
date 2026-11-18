export interface ApiError {
  code: string;
  message: string;
  requestId?: string;
}

export interface HealthResponse {
  status: 'ok';
  service: string;
}
