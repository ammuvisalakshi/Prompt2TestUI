import { Amplify } from 'aws-amplify'

export function configureAmplify() {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: import.meta.env.VITE_USER_POOL_ID as string,
        userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID as string,
        identityPoolId: import.meta.env.VITE_IDENTITY_POOL_ID as string,
        loginWith: { email: true },
      },
    },
  })
}
