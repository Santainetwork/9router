docker stop -t 330 9router
docker rm 9router
docker build -t 9router .
docker run -d --stop-timeout 330 --name 9router -p 20128:20128 --env-file .env -v 9router-data:/app/data 9router
