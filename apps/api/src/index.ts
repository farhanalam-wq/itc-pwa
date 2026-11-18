import { app } from './app';

const port = Number(Bun.env.PORT ?? 3002);

app.listen(port);

console.log('ITC Field Source API shell listening on port ' + port);
