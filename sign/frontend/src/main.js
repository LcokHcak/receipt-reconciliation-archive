import { createApp } from 'vue'
import { installErrorReporter } from './lib/errorReporter'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import './style.css'

const app = createApp(App)
installErrorReporter(app) // #4 系统喊疼:未捕获异常上报 /api/client-errors
app
  .use(createPinia())
  .use(router)
  .mount('#app')
