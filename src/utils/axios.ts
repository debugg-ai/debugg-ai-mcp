import axios from "axios";


const axiosServices = axios.create({
  baseURL: process.env.REACT_APP_API_URL || "http://localhost:81",
  headers: {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Authorization": "Token 6f960ed60c88b5af7d1d7ecfabeee53f5068dc4d",
  },
});

// ==============================|| AXIOS - FOR MOCK SERVICES ||============================== //

axiosServices.interceptors.response.use(
  (response) => {
    //console.error(`Response data....${response.data}`)
    if (response.data) {
      // response.data = objToCamelCase(response.data);
      // response.data = response.data;
    }
    return response;
  },
  (error) => {
    // let host = window.location.host;
    // let parts = host.split(".");
    // let subdomain = parts[0];
    // if (error.response.status === 401 && subdomain == 'app' && !window.location.href.includes('/login')) {
    //   window.location = '/login';
    // }
    if (error) {
      // error = objToCamelCase(error);
    }
    return Promise.reject((error.response && error.response.data) || "Wrong Services");
  }
);

axiosServices.interceptors.request.use(
  async (config) => {
    // Update naming convention from CamelCase to the underscored type
    return config;
  },
  (error) => error
);

export default axiosServices;

export const { get, post, put, delete: destroy } = axiosServices;
