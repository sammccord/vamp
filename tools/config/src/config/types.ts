export interface FrameworkConfig {
  /** Path to the bebop.json config file (default: "./bebop.json") */
  bebopConfig?: string;
  schemas: {
    entity: string;
    actions: string;
    state: string;
  };
  outFile: string;
}

export interface BebopConfig {
  include?: string[];
  exclude?: string[];
  generators?: {
    ts?: {
      outFile?: string;
    };
  };
  watchOptions?: {
    excludeDirectories?: string[];
  };
}
