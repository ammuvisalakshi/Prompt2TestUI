import { createContext, useContext } from 'react'

export const ENVS = ['dev', 'qa', 'uat', 'prod'] as const
export type Env = typeof ENVS[number]

export const ENV_COLORS: Record<Env, string> = {
  dev:  'text-green-700 bg-green-50 border-green-200',
  qa:   'text-blue-700 bg-blue-50 border-blue-200',
  uat:  'text-amber-700 bg-amber-50 border-amber-200',
  prod: 'text-red-700 bg-red-50 border-red-200',
}

export const ENV_DOT: Record<Env, string> = {
  dev:  'bg-green-400',
  qa:   'bg-blue-400',
  uat:  'bg-amber-400',
  prod: 'bg-red-400',
}

type EnvContextType = { env: Env; setEnv: (e: Env) => void }
export const EnvContext = createContext<EnvContextType>({ env: 'dev', setEnv: () => {} })
export const useEnv = () => useContext(EnvContext)
